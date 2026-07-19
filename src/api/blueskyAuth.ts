// Bluesky（AT Protocol）の PlatformAccount 管理・セッション・投稿。
// 認証はアプリパスワード方式。accessJwt は数時間、refreshJwt は約2ヶ月で失効する。
// トークン延命はオンデマンド回復（投稿時に失効検知 → refresh → だめなら再ログイン）で行う
// （development-plan.md Phase 2 / トークン更新方針）。

import { BlueskyAccount } from "../types";
import { maskSensitive, fetchWithRetries, requireNonEmptyString } from "../utils";

const BSKY_SERVICE = "https://bsky.social";
const BSKY_ACCOUNT_PREFIX = "BLUESKY_ACCOUNT_";

function accountKey(accountId: string): string {
  return BSKY_ACCOUNT_PREFIX + accountId;
}

/** 保存済みの Bluesky アカウントを読み込む。無ければ例外 */
function loadBlueskyAccount(accountId: string): BlueskyAccount {
  const raw = PropertiesService.getScriptProperties().getProperty(accountKey(accountId));
  if (!raw) {
    throw new Error(`Bluesky account not found: ${accountId}`);
  }
  return JSON.parse(raw) as BlueskyAccount;
}

/** Bluesky アカウントを保存する（トークン込み） */
function saveBlueskyAccount(account: BlueskyAccount): void {
  PropertiesService.getScriptProperties().setProperty(
    accountKey(account.accountId),
    JSON.stringify(account)
  );
}

/** API 応答から機密を除いた表示用アカウント */
function maskAccount(account: BlueskyAccount) {
  return {
    accountId: account.accountId,
    platform: "bluesky" as const,
    displayName: account.displayName || "",
    handle: account.handle,
    appPassword: maskSensitive(account.appPassword),
    did: account.did || "",
    hasSession: Boolean(account.accessJwt),
  };
}

// ---- セッション管理 ----

/** createSession（ログイン）。did / accessJwt / refreshJwt を取得して保存する */
export function blueskyLogin(account: BlueskyAccount): BlueskyAccount {
  const res = fetchWithRetries(`${BSKY_SERVICE}/xrpc/com.atproto.server.createSession`, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ identifier: account.handle, password: account.appPassword }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.accessJwt) {
    throw new Error(`Bluesky ログインに失敗しました (${account.accountId}): ${JSON.stringify(data)}`);
  }
  account.did = data.did;
  account.accessJwt = data.accessJwt;
  account.refreshJwt = data.refreshJwt;
  saveBlueskyAccount(account);
  return account;
}

/** refreshSession。refreshJwt で accessJwt を更新する。失敗時は例外（呼び出し側で再ログイン） */
function blueskyRefresh(account: BlueskyAccount): BlueskyAccount {
  if (!account.refreshJwt) {
    throw new Error("No refreshJwt to refresh.");
  }
  const res = fetchWithRetries(`${BSKY_SERVICE}/xrpc/com.atproto.server.refreshSession`, {
    method: "post",
    headers: { Authorization: "Bearer " + account.refreshJwt },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.accessJwt) {
    throw new Error(`Bluesky セッション更新に失敗しました (${account.accountId}): ${JSON.stringify(data)}`);
  }
  account.accessJwt = data.accessJwt;
  account.refreshJwt = data.refreshJwt;
  saveBlueskyAccount(account);
  return account;
}

// ---- 投稿 ----

const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const BLUESKY_MAX_BLOB_BYTES = 1000000; // AT Protocol の blob 上限（1MB）
const BLUESKY_MAX_IMAGES = 4; // app.bsky.embed.images は最大 4 枚

/** トークン失効を表す内部エラー（回復して 1 回だけ再試行するトリガー） */
class BlueskyAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlueskyAuthError";
  }
}

/** レスポンスがトークン失効によるものか判定する（401、または 400 + ExpiredToken/InvalidToken） */
function isExpiredAuthResponse(res: GoogleAppsScript.URL_Fetch.HTTPResponse): boolean {
  const code = res.getResponseCode();
  if (code === 401) return true;
  if (code !== 400) return false;
  try {
    const body = JSON.parse(res.getContentText());
    return body.error === "ExpiredToken" || body.error === "InvalidToken";
  } catch (e) {
    return false;
  }
}

/**
 * 画像 URL をフェッチ・検証し、uploadBlob して blob 参照を返す。
 * Bluesky は image_url 方式が無く、GAS がバイト列を uploadBlob する必要がある。
 */
function uploadBlueskyBlob(account: BlueskyAccount, imageUrl: string): any {
  const fetchRes = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
  if (fetchRes.getResponseCode() !== 200) {
    throw new Error(`画像の取得に失敗 (HTTP ${fetchRes.getResponseCode()}): ${imageUrl}`);
  }
  const blob = fetchRes.getBlob();
  const mime = (blob.getContentType() || "").toLowerCase();
  if (ALLOWED_IMAGE_MIME.indexOf(mime) === -1) {
    throw new Error(
      `未対応の画像形式です (${mime || "unknown"}): ${imageUrl}。対応: JPEG/PNG/GIF/WebP`
    );
  }
  const bytes = blob.getBytes();
  if (bytes.length > BLUESKY_MAX_BLOB_BYTES) {
    throw new Error(
      `画像サイズが Bluesky の上限(1MB)を超えています (${bytes.length} bytes): ${imageUrl}`
    );
  }
  const res = UrlFetchApp.fetch(`${BSKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`, {
    method: "post",
    contentType: mime,
    headers: { Authorization: "Bearer " + account.accessJwt },
    payload: bytes,
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 401) {
    throw new BlueskyAuthError("uploadBlob が 401");
  }
  const data = JSON.parse(res.getContentText());
  if (!data.blob) {
    throw new Error(`uploadBlob に失敗: ${JSON.stringify(data)}`);
  }
  return data.blob;
}

/** createRecord を 1 回叩く（HTTPResponse をそのまま返し、呼び出し側で失効判定する） */
function createRecordRequest(
  account: BlueskyAccount,
  text: string,
  embed?: any
): GoogleAppsScript.URL_Fetch.HTTPResponse {
  const record: any = {
    $type: "app.bsky.feed.post",
    text: text,
    createdAt: new Date().toISOString(),
  };
  if (embed) record.embed = embed;
  const payload = {
    repo: account.did,
    collection: "app.bsky.feed.post",
    record,
  };
  return fetchWithRetries(`${BSKY_SERVICE}/xrpc/com.atproto.repo.createRecord`, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + account.accessJwt },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

/** 画像アップロード + createRecord を 1 セット実行する。トークン失効時は BlueskyAuthError を投げる */
function doBlueskyPost(account: BlueskyAccount, text: string, images: string[]): string {
  let embed: any = undefined;
  if (images.length) {
    const uploaded = images.map((url) => ({ alt: "", image: uploadBlueskyBlob(account, url) }));
    embed = { $type: "app.bsky.embed.images", images: uploaded };
  }
  const res = createRecordRequest(account, text, embed);
  if (isExpiredAuthResponse(res)) {
    throw new BlueskyAuthError("createRecord が失効応答");
  }
  const data = JSON.parse(res.getContentText());
  if (!data.uri) {
    throw new Error(`Bluesky 投稿に失敗しました: ${JSON.stringify(data)}`);
  }
  return data.uri;
}

/**
 * Bluesky に投稿する（テキスト、任意で画像 1〜4 枚）。
 * トークン失効時はオンデマンドで回復して 1 回だけ再試行する
 * （400 の文字数超過等では回復せず、そのままエラーにする）。
 * @return 投稿の AT URI（例: at://did:plc:xxxx/app.bsky.feed.post/xxxx）
 */
export function postToBluesky(accountId: string, text: string, mediaUrls?: string[]): string {
  const images = (mediaUrls || []).filter((u) => u && String(u).trim());
  if (images.length > BLUESKY_MAX_IMAGES) {
    throw new Error(`Bluesky は画像 ${BLUESKY_MAX_IMAGES} 枚までです（${images.length} 枚指定）`);
  }

  let account = loadBlueskyAccount(accountId);
  if (!account.accessJwt || !account.did) {
    account = blueskyLogin(account);
  }

  try {
    return doBlueskyPost(account, text, images);
  } catch (e) {
    if (!(e instanceof BlueskyAuthError)) throw e;
    // 失効 → refresh、だめなら再ログインして 1 回だけ再試行（blob も新トークンで再アップロード）
    try {
      account = blueskyRefresh(account);
    } catch (refreshErr) {
      account = blueskyLogin(account);
    }
    return doBlueskyPost(account, text, images);
  }
}

// ---- アカウント CRUD（ルーターから呼ばれる）----

/** アカウントを新規登録する。認証情報を検証するため即ログインし did/JWT を保存する */
export function createBlueskyAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  const handle = requireNonEmptyString(data?.handle, "handle");
  const appPassword = requireNonEmptyString(data?.appPassword, "appPassword");

  if (PropertiesService.getScriptProperties().getProperty(accountKey(accountId))) {
    throw new Error(`Bluesky account already exists: ${accountId}`);
  }

  const account: BlueskyAccount = {
    accountId,
    platform: "bluesky",
    displayName: data?.displayName ? String(data.displayName) : "",
    handle,
    appPassword,
  };
  // 認証情報の検証を兼ねてログイン（失敗すれば保存されない）
  const loggedIn = blueskyLogin(account);
  return maskAccount(loggedIn);
}

/** 全 Bluesky アカウントを返す（機密はマスク） */
export function getBlueskyAuthAll() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  return Object.keys(all)
    .filter((k) => k.indexOf(BSKY_ACCOUNT_PREFIX) === 0)
    .map((k) => maskAccount(JSON.parse(all[k]) as BlueskyAccount));
}

/** アカウントを更新する（handle / appPassword / displayName）。認証情報変更時は再ログイン */
export function updateBlueskyAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  const account = loadBlueskyAccount(accountId);

  let credsChanged = false;
  if (data?.handle && String(data.handle).trim() !== account.handle) {
    account.handle = String(data.handle).trim();
    credsChanged = true;
  }
  if (data?.appPassword && String(data.appPassword).trim() !== account.appPassword) {
    account.appPassword = String(data.appPassword).trim();
    credsChanged = true;
  }
  if (data?.displayName !== undefined) {
    account.displayName = String(data.displayName);
  }

  if (credsChanged) {
    return maskAccount(blueskyLogin(account));
  }
  saveBlueskyAccount(account);
  return maskAccount(account);
}

/** アカウントを削除する */
export function deleteBlueskyAuth(data: any) {
  const accountId = requireNonEmptyString(data?.accountId, "accountId");
  PropertiesService.getScriptProperties().deleteProperty(accountKey(accountId));
  return { accountId, deleted: true };
}
