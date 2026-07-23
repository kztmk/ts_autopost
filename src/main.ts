// NOTE: initializeSheets（sheets.ts）はメニューから文字列名で呼ぶため import しない。
// import するとバンドル時に名前が衝突し initializeSheets2 にリネームされ、
// メニューの "initializeSheets" 呼び出しが解決できなくなる。
import {
  assertProxyAuthorized,
  stripAuthField,
  initializeProxyAuth,
  getSecurityStatus,
  generateSetupCode,
  clearProxyAuth,
} from "./security";
import {
  createBlueskyAuth,
  getBlueskyAuthAll,
  updateBlueskyAuth,
  deleteBlueskyAuth,
} from "./api/blueskyAuth";
import {
  createPost,
  createMultiplePosts,
  deletePost,
  fetchPosts,
  fetchPostedData,
  fetchErrorData,
  updateInReplyTo,
  updatePost,
  updatePostSchedule,
} from "./api/postData";
import {
  createPostingTrigger,
  deletePostingTriggers,
  checkTriggerExists,
  ensureEngagementTrigger,
  deleteEngagementTrigger,
  POSTING_HANDLER,
} from "./api/triggers";
import { getAccountInsights, runEngagementUpdateOnce } from "./insights";
import { archiveSheet } from "./api/archive";
import {
  createThreadsAuth,
  getThreadsAuthAll,
  updateThreadsAuth,
  deleteThreadsAuth,
  getThreadsAuthorizeUrl,
  getThreadsPermalink,
  isThreadsOAuthCallback,
  handleThreadsOAuthCallback,
  ensureThreadsMaintenanceTrigger,
  deleteThreadsMaintenanceTrigger,
} from "./api/threadsAuth";
import {
  upsertNotificationSettings,
  testNotification,
} from "./api/notifications";
import { getUiLang } from "./utils";

// ============================================================
// Web アプリのルーター（doGet / doPost）
//
// リクエストは ?target=<対象>&action=<操作> で分岐する
// （x_Autopost と同じ target/action 方式）。
// ============================================================

function jsonSuccess(data: any, code: number = 200): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(
    JSON.stringify({ status: "success", data, code })
  ).setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message: string, code: number = 400): GoogleAppsScript.Content.TextOutput {
  return ContentService.createTextOutput(
    JSON.stringify({ status: "error", message, code })
  ).setMimeType(ContentService.MimeType.JSON);
}

/** メニュー・ダイアログの表示文言（日英）。 */
const UI_STRINGS = {
  ja: {
    menuTitle: "Autopost 連携",
    setupDeploy: "セットアップ（URL・本人確認コード）",
    updateRelease: "更新手順を表示",
    generateCode: "本人確認コードを生成（手動）",
    initSheets: "シート初期化（手動）",
    dialogTitle: "本人確認コード",
    dialogHeading: "本人確認コード",
    dialogBody:
      "以下のコードをアプリのプロフィール画面に入力してください。<br>このコードの有効期限は10分です。",
    copyLabel: "コピー",
    copiedLabel: "コピーしました",
  },
  en: {
    menuTitle: "Autopost",
    setupDeploy: "Set up (URL & code)",
    updateRelease: "Show update steps",
    generateCode: "Generate verification code (manual)",
    initSheets: "Initialize sheets (manual)",
    dialogTitle: "Verification code",
    dialogHeading: "Verification code",
    dialogBody:
      "Enter the code below on the app's profile screen.<br>This code is valid for 10 minutes.",
    copyLabel: "Copy",
    copiedLabel: "Copied",
  },
} as const;

/**
 * Spreadsheet を開いたときにメニューを追加する。
 * メニュー文言は Google アカウントのロケールに応じて日本語/英語で出す。
 *
 * 認証ポップアップを1回で済ませるため、デプロイが完了して初めて「セットアップ」を出す。
 * （未デプロイのうちにメニューを実行すると認証ポップアップが起き、その後デプロイで再度
 *  認証が走って二重になるため。先にデプロイ→再読込→この項目が出る、という順にする。）
 * 判定は ScriptApp.getService().getUrl()。取得不可（例外）時は安全側で項目を出す。
 */
export function onOpen(): void {
  const s = UI_STRINGS[getUiLang()];
  const menu = SpreadsheetApp.getUi().createMenu(s.menuTitle);

  let deployed = false;
  let detectionWorked = true;
  try {
    deployed = Boolean(ScriptApp.getService().getUrl());
  } catch (e) {
    detectionWorked = false;
  }

  // デプロイ済み、または判定不能（安全側）のときだけセットアップ/更新を出す。
  if (deployed || !detectionWorked) {
    menu.addItem(s.setupDeploy, "deploySetup");
    menu.addItem(s.updateRelease, "updateFromRelease");
    menu.addSeparator();
  }

  // 手動フォールバック（常時表示）。
  menu.addItem(s.generateCode, "showSetupCodeDialog");
  menu.addItem(s.initSheets, "initializeSheets");
  menu.addToUi();
}

/**
 * フロントアプリへ入力する本人確認コードを生成し、コピーしやすいダイアログで表示する。
 * onOpen のメニューから文字列名で呼ばれる。
 */
export function showSetupCodeDialog(): void {
  const s = UI_STRINGS[getUiLang()];
  const setupCode = generateSetupCode();
  const html = HtmlService.createHtmlOutput(
    `
      <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
        <h2 style="font-size: 18px; margin: 0 0 12px;">${s.dialogHeading}</h2>
        <p style="font-size: 13px; line-height: 1.7; margin: 0 0 12px;">
          ${s.dialogBody}
        </p>
        <input
          id="setupCode"
          type="text"
          readonly
          value="${setupCode}"
          style="box-sizing: border-box; width: 100%; padding: 10px; font-size: 16px; font-family: monospace;"
        />
        <button
          onclick="copyCode()"
          style="margin-top: 12px; padding: 8px 12px; border: 0; border-radius: 4px; background: #1a73e8; color: white; cursor: pointer;"
        >
          ${s.copyLabel}
        </button>
        <span id="copyStatus" style="margin-left: 8px; font-size: 12px; color: #188038;"></span>
        <script>
          const input = document.getElementById('setupCode');
          input.focus();
          input.select();
          function copyCode() {
            input.select();
            document.execCommand('copy');
            document.getElementById('copyStatus').textContent = ${JSON.stringify(s.copiedLabel)};
          }
        </script>
      </div>
    `
  )
    .setWidth(460)
    .setHeight(260);

  SpreadsheetApp.getUi().showModalDialog(html, s.dialogTitle);
}

/**
 * 【エディタ実行用】本人確認コードを生成し、実行ログに出力する。
 *
 * showSetupCodeDialog は SpreadsheetApp.getUi()（UI コンテキスト）を必要とし、
 * エディタの実行ボタンからは Permission エラーになる。またメニュー初回クリックは
 * 「承認」と「UI 表示」が同時に必要で失敗しやすい。この関数は getUi を使わないため
 * エディタから実行でき、初回実行で OAuth 承認も同時に完了する。
 *
 * 生成されるコードは 10 分間有効な一回限りの本人確認用（proxySecret ではない）。
 * 実行ログは所有者しか見られないが、セットアップ完了後はこの関数を削除してもよい。
 */
export function setup_generateSetupCode(): void {
  const code = generateSetupCode();
  Logger.log("本人確認コード（10分間有効・アプリの接続画面に入力）: " + code);
}

/**
 * 【エディタ実行用】Proxy 認可の紐付けをリセットする。
 * 本番フロント（実 Firebase uid）で初期化し直す前に、テスト uid の紐付けを解除する。
 * 実行後は本人確認コードを生成し直してフロントで再初期化すること。
 */
export function setup_resetProxyAuth(): void {
  const r = clearProxyAuth();
  Logger.log(`Proxy 認可をリセットしました（旧 ownerUid: ${r.previousOwnerUid || "なし"}）。`);
}

/**
 * POST リクエストの処理。
 */
export function doPost(e: any): GoogleAppsScript.Content.TextOutput {
  const action = e?.parameter?.action || "";
  const target = e?.parameter?.target || "";

  try {
    let requestData: any = {};
    if (
      e?.postData &&
      e.postData.type === "application/json" &&
      e.postData.contents
    ) {
      requestData = JSON.parse(e.postData.contents);
    } else if (e?.postData && e.postData.contents) {
      throw new Error("Invalid request body format. Expected application/json.");
    }

    // security.initialize は唯一の無認証 POST（初回接続時に setup code で紐付け）。
    if (target === "security" && action === "initialize") {
      const initialized = initializeProxyAuth(requestData);
      return jsonSuccess(initialized, 201);
    }

    // これ以降はすべて署名検証を要求する。認証失敗は 401 に確定させる
    // （x_Autopost apiv2.ts の「assertProxyAuthorized 直前に statusCode=401」方式に相当）。
    try {
      assertProxyAuthorized(e, action, target, requestData, "POST");
    } catch (authError: any) {
      Logger.log(`doPost auth rejected (action=${action}, target=${target}): ${authError.message}`);
      return jsonError(authError.message, 401);
    }
    requestData = stripAuthField(requestData);

    switch (target) {
      case "blueskyAuth":
        switch (action) {
          case "create":
            return jsonSuccess(createBlueskyAuth(requestData), 201);
          case "update":
            return jsonSuccess(updateBlueskyAuth(requestData));
          case "delete":
            return jsonSuccess(deleteBlueskyAuth(requestData));
          default:
            return jsonError(`Invalid action '${action}' for target 'blueskyAuth'`, 400);
        }
      case "postData":
        switch (action) {
          case "create":
            return jsonSuccess(createPost(requestData), 201);
          case "createMultiple":
            return jsonSuccess(createMultiplePosts(requestData.posts || requestData), 201);
          case "updateInReplyTo":
            // ペイロードキーは updates を第一候補とする（threads は x_Autopost API 互換。
            // Platform 名 "threads" と紛らわしいため新規利用では updates を使うこと）。
            return jsonSuccess(
              updateInReplyTo(requestData.updates || requestData.threads || requestData)
            );
          case "updateSchedule":
            return jsonSuccess(updatePostSchedule(requestData.updates || requestData));
          case "update":
            return jsonSuccess(updatePost(requestData));
          case "delete":
            return jsonSuccess(deletePost(requestData));
          default:
            return jsonError(`Invalid action '${action}' for target 'postData'`, 400);
        }
      case "trigger":
        switch (action) {
          case "status":
            // Proxy は fetch 以外を POST で転送するため、状態確認も POST で受ける
            // （GET 側 doGet にも同等の status あり）。
            return jsonSuccess(
              checkTriggerExists(requestData?.functionName || POSTING_HANDLER)
            );
          case "create":
            return jsonSuccess(createPostingTrigger(requestData), 201);
          case "delete":
            return jsonSuccess(deletePostingTriggers());
          case "ensureMaintenance":
            return jsonSuccess(ensureThreadsMaintenanceTrigger(), 201);
          case "deleteMaintenance":
            return jsonSuccess(deleteThreadsMaintenanceTrigger());
          case "ensureEngagement":
            return jsonSuccess(ensureEngagementTrigger(), 201);
          case "deleteEngagement":
            return jsonSuccess(deleteEngagementTrigger());
          default:
            return jsonError(`Invalid action '${action}' for target 'trigger'`, 400);
        }
      case "insights":
        // account（読み取り）は GET 側で提供する。ここは更新系のみ。
        if (action === "refresh") {
          runEngagementUpdateOnce();
          return jsonSuccess({ status: "started" });
        }
        return jsonError(`Invalid action '${action}' for target 'insights'`, 400);
      case "archive":
        if (action === "run") {
          return jsonSuccess(archiveSheet(requestData.source, requestData.filename), 201);
        }
        return jsonError(`Invalid action '${action}' for target 'archive'`, 400);
      case "threadsAuth":
        switch (action) {
          case "create":
            return jsonSuccess(createThreadsAuth(requestData), 201);
          case "update":
            return jsonSuccess(updateThreadsAuth(requestData));
          case "delete":
            return jsonSuccess(deleteThreadsAuth(requestData));
          case "authorizeUrl":
            return jsonSuccess(getThreadsAuthorizeUrl(requestData));
          case "permalink":
            return jsonSuccess(getThreadsPermalink(requestData));
          default:
            return jsonError(`Invalid action '${action}' for target 'threadsAuth'`, 400);
        }
      case "notificationSettings":
        switch (action) {
          case "upsert":
            return jsonSuccess(upsertNotificationSettings(requestData));
          case "test":
            return jsonSuccess(testNotification(requestData));
          default:
            return jsonError(`Invalid action '${action}' for target 'notificationSettings'`, 400);
        }
      default:
        return jsonError(`Invalid target '${target}'`, 400);
    }
  } catch (error: any) {
    Logger.log(`doPost error (action=${action}, target=${target}): ${error.message}`);
    return jsonError(error.message, 400);
  }
}

/**
 * GET リクエストの処理。
 */
export function doGet(
  e: any
): GoogleAppsScript.Content.TextOutput | GoogleAppsScript.HTML.HtmlOutput {
  const action = e?.parameter?.action || "";
  const target = e?.parameter?.target || "";

  try {
    // security.status は唯一の無認証 GET（疎通確認・初期化状態の確認）。
    if (target === "security" && action === "status") {
      return jsonSuccess(getSecurityStatus());
    }

    // Threads OAuth の無認証コールバックルート（ADR 0003）。
    // Meta からのリダイレクトは target を持たず ?state=...&code=...（または error）で届く。
    // CSRF/紐付け検証は handleThreadsOAuthCallback 内の state 検証が担う。
    if (isThreadsOAuthCallback(e)) {
      return handleThreadsOAuthCallback(e);
    }

    // これ以降はすべて署名検証を要求する。認証失敗は 401 に確定させる。
    try {
      assertProxyAuthorized(e, action, target, {}, "GET");
    } catch (authError: any) {
      Logger.log(`doGet auth rejected (action=${action}, target=${target}): ${authError.message}`);
      return jsonError(authError.message, 401);
    }

    switch (target) {
      case "blueskyAuth":
        if (action === "fetch") return jsonSuccess(getBlueskyAuthAll());
        return jsonError(`Invalid action '${action}' for target 'blueskyAuth'`, 400);
      case "postData":
        if (action === "fetch") return jsonSuccess(fetchPosts());
        return jsonError(`Invalid action '${action}' for target 'postData'`, 400);
      case "postedData":
        if (action === "fetch") return jsonSuccess(fetchPostedData());
        return jsonError(`Invalid action '${action}' for target 'postedData'`, 400);
      case "errorData":
        if (action === "fetch") return jsonSuccess(fetchErrorData());
        return jsonError(`Invalid action '${action}' for target 'errorData'`, 400);
      case "trigger":
        if (action === "status") return jsonSuccess(checkTriggerExists(e?.parameter?.functionName || POSTING_HANDLER));
        return jsonError(`Invalid action '${action}' for target 'trigger'`, 400);
      case "threadsAuth":
        if (action === "fetch") return jsonSuccess(getThreadsAuthAll());
        return jsonError(`Invalid action '${action}' for target 'threadsAuth'`, 400);
      case "insights":
        // アカウント全体の現在値（オンデマンド GET）。platform/accountId はクエリで受け取る。
        if (action === "account") {
          return jsonSuccess(
            getAccountInsights({
              platform: e?.parameter?.platform,
              accountId: e?.parameter?.accountId,
            })
          );
        }
        return jsonError(`Invalid action '${action}' for target 'insights' in GET request`, 400);
      default:
        return jsonError(`Invalid target '${target}' in GET request`, 400);
    }
  } catch (error: any) {
    Logger.log(`doGet error (action=${action}, target=${target}): ${error.message}`);
    return jsonError(error.message, 400);
  }
}
