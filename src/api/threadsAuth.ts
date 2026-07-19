// Threads（Meta Graph API）の PlatformAccount 管理と OAuth。
// ADR 0003: BYO Meta アプリ方式。ユーザーが自分の Meta アプリの App ID/Secret を登録し、
// 認可リダイレクトは本人の GAS doGet 上の無認証コールバックルートで受ける。
// state パラメータ（CacheService に 10 分保持する nonce）で PlatformAccount 紐付けと
// CSRF 検証を行う。スコープには最初から threads_manage_insights を含める（ADR 0003 帰結）。
//
// トークン: 認可コード → 短期トークン → 長期トークン（60 日）。
// 延命は日次メンテナンストリガー（threadsTokenMaintenance）が、発行から
// REFRESH_AFTER_DAYS 経過したトークンのみ th_refresh_token でリフレッシュする。

import { ThreadsAccount } from "../types";
import {
  maskSensitive,
  fetchWithRetries,
  requireNonEmptyString,
  logErrorToSheet,
  newId,
  deleteTriggersByHandler,
} from "../utils";

const THREADS_GRAPH = "https://graph.threads.net";
const THREADS_GRAPH_V1 = "https://graph.threads.net/v1.0";
const THREADS_AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const THREADS_SCOPES = "threads_basic,threads_content_publish,threads_manage_insights";
const THREADS_ACCOUNT_PREFIX = "THREADS_ACCOUNT_";
const OAUTH_STATE_CACHE_PREFIX = "threads_oauth_state_";
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
/** 発行からこの日数を超えた長期トークンを日次メンテナンスでリフレッシュする */
const REFRESH_AFTER_DAYS = 30;

function threadsAccountKey(accountId: string): string {
  return THREADS_ACCOUNT_PREFIX + accountId;
}

/** 保存済みの Threads アカウントを読み込む。無ければ例外 */
function loadThreadsAccount(accountId: string): ThreadsAccount {
  const raw = PropertiesService.getScriptProperties().getProperty(threadsAccountKey(accountId));
  if (!raw) {
    throw new Error(`Threads account not found: ${accountId}`);
  }
  return JSON.parse(raw) as ThreadsAccount;
}

/** Threads アカウントを保存する（トークン込み） */
function saveThreadsAccount(account: ThreadsAccount): void {
  PropertiesService.getScriptProperties().setProperty(
    threadsAccountKey(account.accountId),
    JSON.stringify(account)
  );
}

/** API 応答から機密を除いた表示用アカウント */
function maskThreadsAccount(account: ThreadsAccount) {
  return {
    accountId: account.accountId,
    platform: "threads" as const,
    displayName: account.displayName || "",
    appId: account.appId,
    appSecret: maskSensitive(account.appSecret),
    userId: account.userId || "",
    authorized: Boolean(account.accessToken),
    tokenSavedAt: account.tokenSavedAt || "",
  };
}

// ---- アカウント CRUD（ルーターから呼ばれる）----

/** アカウントを新規登録する（App ID/Secret のみ。トークンは認可フロー完了時に保存） */
export function createThreadsAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  const appId = requireNonEmptyString(data?.appId, "appId");
  const appSecret = requireNonEmptyString(data?.appSecret, "appSecret");

  if (PropertiesService.getScriptProperties().getProperty(threadsAccountKey(accountId))) {
    throw new Error(`Threads account already exists: ${accountId}`);
  }

  const account: ThreadsAccount = {
    accountId,
    platform: "threads",
    displayName: data?.displayName ? String(data.displayName) : "",
    appId,
    appSecret,
  };
  saveThreadsAccount(account);
  return maskThreadsAccount(account);
}

/** 全 Threads アカウントを返す（機密はマスク） */
export function getThreadsAuthAll() {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all)
    .filter((k) => k.indexOf(THREADS_ACCOUNT_PREFIX) === 0)
    .map((k) => maskThreadsAccount(JSON.parse(all[k]) as ThreadsAccount));
}

/** アカウントを更新する。appId/appSecret 変更時は既存トークンを無効化（要・再認可） */
export function updateThreadsAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  const account = loadThreadsAccount(accountId);

  let credsChanged = false;
  if (data?.appId && String(data.appId).trim() !== account.appId) {
    account.appId = String(data.appId).trim();
    credsChanged = true;
  }
  if (data?.appSecret && String(data.appSecret).trim() !== account.appSecret) {
    account.appSecret = String(data.appSecret).trim();
    credsChanged = true;
  }
  if (data?.displayName !== undefined) {
    account.displayName = String(data.displayName);
  }

  if (credsChanged) {
    // App ID/Secret の変更は通常「別の Meta アプリへの切替」を意味し、その場合
    // 既存トークンは新アプリと無関係になる。タイポ修正のケースでは破棄は過剰だが、
    // どちらか判別できないため安全側に倒して破棄し、再認可を促す
    // （th_refresh_token 自体は access_token だけで動くので、技術的には旧トークンは
    //   Secret 変更後もリフレッシュ可能。破棄は技術制約ではなく方針）。
    delete account.accessToken;
    delete account.userId;
    delete account.tokenSavedAt;
  }
  saveThreadsAccount(account);
  return maskThreadsAccount(account);
}

/** アカウントを削除する */
export function deleteThreadsAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  PropertiesService.getScriptProperties().deleteProperty(threadsAccountKey(accountId));
  return { accountId, deleted: true };
}

// ---- 認可フロー ----

/** この Web アプリ自身の /exec URL（= Meta に登録するリダイレクト URI） */
function getRedirectUri(): string {
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    throw new Error("Web アプリの URL を取得できません。デプロイ済みか確認してください。");
  }
  return url;
}

/**
 * 認可 URL を生成する（フロントはこれをユーザーに開かせる）。
 * state には nonce のみを載せ、accountId と redirectUri は CacheService 側に保持する
 * （リダイレクトで返る state の改竄が意味を持たないように）。
 */
export function getThreadsAuthorizeUrl(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  const account = loadThreadsAccount(accountId);
  const redirectUri = getRedirectUri();

  const nonce = newId().replace(/-/g, "");
  CacheService.getScriptCache().put(
    OAUTH_STATE_CACHE_PREFIX + nonce,
    JSON.stringify({ accountId, redirectUri }),
    OAUTH_STATE_TTL_SECONDS
  );

  const authorizeUrl =
    THREADS_AUTHORIZE_URL +
    `?client_id=${encodeURIComponent(account.appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(THREADS_SCOPES)}` +
    `&response_type=code` +
    `&state=${encodeURIComponent(nonce)}`;

  return {
    accountId,
    authorizeUrl,
    redirectUri, // Meta アプリの「有効な OAuth リダイレクト URI」にこの値を登録する
    expiresInSeconds: OAUTH_STATE_TTL_SECONDS,
  };
}

/** doGet が Threads OAuth コールバックとして扱うべきリクエストか判定する */
export function isThreadsOAuthCallback(e: any): boolean {
  const p = e?.parameter || {};
  return !p.target && Boolean(p.state) && Boolean(p.code || p.error);
}

/** 外部入力を HTML に埋め込む前のエスケープ（無認証ページのため必須） */
function escapeHtml(value: any): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function callbackHtml(title: string, bodyHtml: string): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutput(
    `<div style="font-family: Arial, sans-serif; padding: 24px; color: #202124; max-width: 560px;">
      <h2 style="font-size: 20px; margin: 0 0 12px;">${title}</h2>
      <div style="font-size: 14px; line-height: 1.8;">${bodyHtml}</div>
    </div>`
  );
}

/**
 * Threads API を叩き、requiredField を含む JSON を返す。
 * 欠けていればレスポンス全文を含む Error を投げる（呼び出し側で Errors シートに記録し、
 * 無認証ページには出さないこと）。
 */
function fetchThreadsJson(
  label: string,
  url: string,
  options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions,
  requiredField: string
): any {
  const res = fetchWithRetries(url, { ...options, muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  if (!data[requiredField]) {
    throw new Error(`${label}に失敗: ${JSON.stringify(data)}`);
  }
  return data;
}

/** トークン系エンドポイント用（access_token 必須） */
function fetchThreadsToken(
  label: string,
  url: string,
  options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions
): any {
  return fetchThreadsJson(label, url, options, "access_token");
}

/**
 * Threads 認可リダイレクトの無認証コールバックルート（CONTEXT.md「OAuth コールバックルート」）。
 * state 検証 → 認可コード → 短期トークン → 長期トークン交換 → アカウントへ保存、まで自動で行う。
 */
export function handleThreadsOAuthCallback(e: any): GoogleAppsScript.HTML.HtmlOutput {
  const p = e?.parameter || {};

  // CSRF / 紐付け検証（state は一回限り・10 分で失効）
  const cache = CacheService.getScriptCache();
  const cacheKey = OAUTH_STATE_CACHE_PREFIX + String(p.state || "");
  const stateJson = cache.get(cacheKey);
  cache.remove(cacheKey);
  if (!stateJson) {
    return callbackHtml(
      "認可を受け付けられませんでした",
      "認可リクエストの有効期限（10分）が切れたか、不正なリクエストです。<br>アプリから認可 URL を再発行してやり直してください。"
    );
  }
  const { accountId, redirectUri } = JSON.parse(stateJson);

  if (p.error) {
    // error_description はクエリ由来の外部入力。必ずエスケープして埋め込む
    return callbackHtml(
      "認可がキャンセルされました",
      `Threads 側で認可が完了しませんでした。<br>理由: ${escapeHtml(p.error_description || p.error)}`
    );
  }

  try {
    const account = loadThreadsAccount(accountId);

    // ① 認可コード → 短期アクセストークン
    const shortData = fetchThreadsToken("短期トークン取得", `${THREADS_GRAPH}/oauth/access_token`, {
      method: "post",
      payload: {
        client_id: account.appId,
        client_secret: account.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code: String(p.code),
      },
    });

    // ② 短期 → 長期アクセストークン（60 日）
    const longData = fetchThreadsToken(
      "長期トークン取得",
      `${THREADS_GRAPH}/access_token` +
        `?grant_type=th_exchange_token` +
        `&client_secret=${encodeURIComponent(account.appSecret)}` +
        `&access_token=${encodeURIComponent(shortData.access_token)}`,
      {}
    );

    // ③ 保存 + トークン延命トリガーの確保
    account.userId = String(shortData.user_id);
    account.accessToken = longData.access_token;
    account.tokenSavedAt = new Date().toISOString();
    saveThreadsAccount(account);
    ensureThreadsMaintenanceTrigger();

    return callbackHtml(
      "✅ 認証に成功しました",
      `アカウント「${escapeHtml(accountId)}」の長期アクセストークンを保存しました。<br>このタブは閉じて構いません。`
    );
  } catch (err: any) {
    logErrorToSheet(
      { message: err.message, stack: err.stack, detail: `accountId=${accountId}` },
      "threadsOAuthCallback"
    );
    // 無認証ページのため詳細（API 応答 JSON 等）は出さない。詳細は Errors シートへ。
    return callbackHtml(
      "エラーが発生しました",
      "トークン交換中にエラーが発生しました。詳細はスプレッドシートの Errors シートに記録されています。<br>" +
        "アプリから認可 URL を再発行してやり直してください。"
    );
  }
}

// ---- 長期トークンの延命（日次メンテナンス）----

export const THREADS_MAINTENANCE_HANDLER = "threadsTokenMaintenance";

/** 日次メンテナンストリガーが無ければ作成する（認可完了時に自動確保。API からも呼べる） */
export function ensureThreadsMaintenanceTrigger() {
  const exists = ScriptApp.getProjectTriggers().some(
    (t) => t.getHandlerFunction() === THREADS_MAINTENANCE_HANDLER
  );
  if (exists) {
    return { functionName: THREADS_MAINTENANCE_HANDLER, created: false, exists: true };
  }
  ScriptApp.newTrigger(THREADS_MAINTENANCE_HANDLER).timeBased().everyDays(1).create();
  Logger.log("Threads token maintenance trigger created (daily).");
  return { functionName: THREADS_MAINTENANCE_HANDLER, created: true, exists: true };
}

/** 日次メンテナンストリガーを削除する（誤作成時の後始末用 API） */
export function deleteThreadsMaintenanceTrigger() {
  const deleted = deleteTriggersByHandler(THREADS_MAINTENANCE_HANDLER);
  return { functionName: THREADS_MAINTENANCE_HANDLER, deleted };
}

/**
 * リフレッシュ開始閾値（日）。既定 30 日。
 * スクリプトプロパティ THREADS_REFRESH_AFTER_DAYS で上書きできる
 * （有効域 1〜55 日: 24 時間経過後から更新可・60 日で失効という Threads の窓に収める）。
 */
function getRefreshAfterDays(): number {
  const raw = PropertiesService.getScriptProperties().getProperty(
    "THREADS_REFRESH_AFTER_DAYS"
  );
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!isNaN(n) && n >= 1 && n <= 55) return n;
  return REFRESH_AFTER_DAYS;
}

/**
 * 【トリガーハンドラ】全 Threads アカウントを走査し、発行から閾値日数（既定 30 日）を
 * 超えた長期トークンをリフレッシュする。失敗はアカウント単位で Errors に記録して続行。
 */
export function threadsTokenMaintenance(): void {
  const refreshAfterDays = getRefreshAfterDays();
  const all = PropertiesService.getScriptProperties().getProperties();
  const accountKeys = Object.keys(all).filter(
    (k) => k.indexOf(THREADS_ACCOUNT_PREFIX) === 0
  );

  accountKeys.forEach((key) => {
    const account = JSON.parse(all[key]) as ThreadsAccount;
    if (!account.accessToken || !account.tokenSavedAt) return; // 未認可はスキップ

    const ageMs = Date.now() - new Date(account.tokenSavedAt).getTime();
    if (ageMs < refreshAfterDays * 24 * 60 * 60 * 1000) return; // まだ新しい

    try {
      const data = fetchThreadsToken(
        "トークン更新",
        `${THREADS_GRAPH}/refresh_access_token` +
          `?grant_type=th_refresh_token` +
          `&access_token=${encodeURIComponent(account.accessToken)}`,
        {}
      );
      account.accessToken = data.access_token;
      account.tokenSavedAt = new Date().toISOString();
      saveThreadsAccount(account);
      Logger.log(
        `Threads token refreshed for ${account.accountId} (expires_in ~${Math.floor(
          (data.expires_in || 0) / 86400
        )}d).`
      );
    } catch (err: any) {
      logErrorToSheet(
        { message: err.message, stack: err.stack, detail: `accountId=${account.accountId}` },
        "threadsTokenMaintenance"
      );
    }
  });
}

// ---- 投稿（コンテナ作成 → FINISHED 待ち → 公開の 2 ステップ）----

const CONTAINER_POLL_ATTEMPTS = 6;
const CONTAINER_POLL_INTERVAL_MS = 2000;
/** クォータの既定値（API が config を返さなかった場合の Threads 既定） */
const THREADS_DEFAULT_QUOTA_TOTAL = 250;
const THREADS_DEFAULT_QUOTA_DURATION_SECONDS = 86400;

// ユーザースコープのエンドポイントはトークン所有者エイリアス "me" を使う。
// OAuth の user_id をパスに使うと code 100/subcode 33（object does not exist）になるため、
// トークンから解決される "me" を使ってアカウント ID 不一致を避ける。
const THREADS_ME = "me";

/** 認可済み（accessToken / userId あり）が保証された Threads アカウント */
type AuthorizedThreadsAccount = ThreadsAccount & {
  accessToken: string;
  userId: string;
};

/** 認可済みアカウントを読み込む。未認可なら例外 */
function loadAuthorizedThreadsAccount(accountId: string): AuthorizedThreadsAccount {
  const account = loadThreadsAccount(accountId);
  if (!account.accessToken || !account.userId) {
    throw new Error(`Threads account not authorized: ${accountId}. 再認可が必要です。`);
  }
  return account as AuthorizedThreadsAccount;
}

const THREADS_MAX_CAROUSEL = 20; // Threads カルーセルの上限

/** テキストのみのメディアコンテナを作成し、creation_id を返す */
function createThreadsContainer(account: AuthorizedThreadsAccount, text: string): string {
  const data = fetchThreadsJson(
    "Threads コンテナ作成",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads`,
    {
      method: "post",
      payload: { media_type: "TEXT", text, access_token: account.accessToken },
    },
    "id"
  );
  return data.id;
}

/** 単一画像のコンテナを作成する（Threads は公開 URL を渡し、Threads 側が取得する） */
function createThreadsImageContainer(
  account: AuthorizedThreadsAccount,
  text: string,
  imageUrl: string
): string {
  const data = fetchThreadsJson(
    "Threads 画像コンテナ作成",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads`,
    {
      method: "post",
      payload: {
        media_type: "IMAGE",
        image_url: imageUrl,
        text,
        access_token: account.accessToken,
      },
    },
    "id"
  );
  return data.id;
}

/** カルーセルの子（画像アイテム）コンテナを作成する */
function createThreadsCarouselItem(
  account: AuthorizedThreadsAccount,
  imageUrl: string
): string {
  const data = fetchThreadsJson(
    "Threads カルーセル項目作成",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads`,
    {
      method: "post",
      payload: {
        media_type: "IMAGE",
        image_url: imageUrl,
        is_carousel_item: "true",
        access_token: account.accessToken,
      },
    },
    "id"
  );
  return data.id;
}

/** 複数画像のカルーセルコンテナを作成する（子は事前に FINISHED 済みであること） */
function createThreadsCarouselContainer(
  account: AuthorizedThreadsAccount,
  text: string,
  childIds: string[]
): string {
  const data = fetchThreadsJson(
    "Threads カルーセルコンテナ作成",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads`,
    {
      method: "post",
      payload: {
        media_type: "CAROUSEL",
        children: childIds.join(","),
        text,
        access_token: account.accessToken,
      },
    },
    "id"
  );
  return data.id;
}

/**
 * コンテナが公開可能（FINISHED）になるまでポーリングする（固定 sleep ではない）。
 * TEXT は通常即 FINISHED だが、稀に処理中のことがあるため状態を確認してから公開する。
 */
function waitForContainerFinished(
  account: AuthorizedThreadsAccount,
  creationId: string
): void {
  for (let i = 0; i < CONTAINER_POLL_ATTEMPTS; i++) {
    const res = fetchWithRetries(
      `${THREADS_GRAPH_V1}/${creationId}?fields=status,error_message` +
        `&access_token=${encodeURIComponent(account.accessToken)}`,
      { muteHttpExceptions: true }
    );
    const data = JSON.parse(res.getContentText());
    const status = String(data.status || "");
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(
        `Threads コンテナが ${status}: ${data.error_message || JSON.stringify(data)}`
      );
    }
    if (status !== "IN_PROGRESS") {
      // status 欠落や未知値はエラー応答とみなし、空ポーリングで原因を握り潰さず即失敗させる
      // （タイムアウトの汎用メッセージではなく実レスポンスを Errors に残す）。
      throw new Error(`Threads コンテナ状態が不明: ${JSON.stringify(data)}`);
    }
    if (i < CONTAINER_POLL_ATTEMPTS - 1) {
      Utilities.sleep(CONTAINER_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Threads コンテナが ${(CONTAINER_POLL_ATTEMPTS * CONTAINER_POLL_INTERVAL_MS) / 1000}秒以内に FINISHED になりませんでした。`
  );
}

/** コンテナを公開し、Threads Media ID を返す */
function publishThreadsContainer(
  account: AuthorizedThreadsAccount,
  creationId: string
): string {
  const data = fetchThreadsJson(
    "Threads 公開",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads_publish`,
    {
      method: "post",
      payload: { creation_id: creationId, access_token: account.accessToken },
    },
    "id"
  );
  return data.id;
}

/**
 * Threads に投稿する（テキスト、任意で画像）。
 * 画像 0 枚 = TEXT、1 枚 = IMAGE、2 枚以上 = CAROUSEL。
 * @return 公開後の Threads Media ID
 */
export function postToThreads(accountId: string, text: string, mediaUrls?: string[]): string {
  const account = loadAuthorizedThreadsAccount(accountId);
  const images = (mediaUrls || []).filter((u) => u && String(u).trim());

  let containerId: string;
  if (images.length === 0) {
    containerId = createThreadsContainer(account, text);
  } else if (images.length === 1) {
    containerId = createThreadsImageContainer(account, text, images[0]);
  } else {
    if (images.length > THREADS_MAX_CAROUSEL) {
      throw new Error(`Threads カルーセルは ${THREADS_MAX_CAROUSEL} 枚までです（${images.length} 枚指定）`);
    }
    // 各子コンテナを作成し、すべて FINISHED になってからカルーセル本体を作る
    const childIds = images.map((url) => createThreadsCarouselItem(account, url));
    childIds.forEach((id) => waitForContainerFinished(account, id));
    containerId = createThreadsCarouselContainer(account, text, childIds);
  }

  waitForContainerFinished(account, containerId);
  return publishThreadsContainer(account, containerId);
}

// ---- レート制限（threads_publishing_limit）----

/** 現在の投稿クォータ使用状況を返す */
export function getThreadsPublishingLimit(accountId: string): {
  quotaUsage: number;
  quotaTotal: number;
  quotaDuration: number;
} {
  const account = loadAuthorizedThreadsAccount(accountId);
  const data = fetchThreadsJson(
    "レート制限情報の取得",
    `${THREADS_GRAPH_V1}/${THREADS_ME}/threads_publishing_limit` +
      `?fields=quota_usage,config&access_token=${encodeURIComponent(account.accessToken)}`,
    {},
    "data"
  );
  const d = data.data[0];
  if (!d) {
    throw new Error(`レート制限情報の取得に失敗: ${JSON.stringify(data)}`);
  }
  return {
    quotaUsage: d.quota_usage || 0,
    quotaTotal: (d.config && d.config.quota_total) || THREADS_DEFAULT_QUOTA_TOTAL,
    quotaDuration:
      (d.config && d.config.quota_duration) || THREADS_DEFAULT_QUOTA_DURATION_SECONDS,
  };
}

/**
 * 投稿クォータの残枠を返す。
 * 判定できない場合（未認可・通信失敗等）は Infinity を返し、実投稿側で成否判定させる。
 */
export function getThreadsRemainingQuota(accountId: string): number {
  try {
    const { quotaUsage, quotaTotal } = getThreadsPublishingLimit(accountId);
    return Math.max(quotaTotal - quotaUsage, 0);
  } catch (e: any) {
    Logger.log(`getThreadsRemainingQuota: 判定不能につき投稿を試行 (${accountId}): ${e.message}`);
    return Infinity;
  }
}
