// NOTE: initializeSheets（sheets.ts）はメニューから文字列名で呼ぶため import しない。
// import するとバンドル時に名前が衝突し initializeSheets2 にリネームされ、
// メニューの "initializeSheets" 呼び出しが解決できなくなる。
import {
  assertProxyAuthorized,
  stripAuthField,
  initializeProxyAuth,
  getSecurityStatus,
  generateSetupCode,
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
  isThreadsOAuthCallback,
  handleThreadsOAuthCallback,
  ensureThreadsMaintenanceTrigger,
  deleteThreadsMaintenanceTrigger,
} from "./api/threadsAuth";

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

/**
 * Spreadsheet を開いたときにメニューを追加する。
 */
export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("Autopost 連携")
    .addItem("本人確認コードを生成", "showSetupCodeDialog")
    .addSeparator()
    .addItem("シート初期化", "initializeSheets")
    .addToUi();
}

/**
 * フロントアプリへ入力する本人確認コードを生成し、コピーしやすいダイアログで表示する。
 * onOpen のメニューから文字列名で呼ばれる。
 */
export function showSetupCodeDialog(): void {
  const setupCode = generateSetupCode();
  const html = HtmlService.createHtmlOutput(
    `
      <div style="font-family: Arial, sans-serif; padding: 16px; color: #202124;">
        <h2 style="font-size: 18px; margin: 0 0 12px;">本人確認コード</h2>
        <p style="font-size: 13px; line-height: 1.7; margin: 0 0 12px;">
          以下のコードをアプリのプロフィール画面に入力してください。<br>
          このコードの有効期限は10分です。
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
          コピー
        </button>
        <span id="copyStatus" style="margin-left: 8px; font-size: 12px; color: #188038;"></span>
        <script>
          const input = document.getElementById('setupCode');
          input.focus();
          input.select();
          function copyCode() {
            input.select();
            document.execCommand('copy');
            document.getElementById('copyStatus').textContent = 'コピーしました';
          }
        </script>
      </div>
    `
  )
    .setWidth(460)
    .setHeight(260);

  SpreadsheetApp.getUi().showModalDialog(html, "本人確認コード");
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
          case "delete":
            return jsonSuccess(deletePost(requestData));
          default:
            return jsonError(`Invalid action '${action}' for target 'postData'`, 400);
        }
      case "trigger":
        switch (action) {
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
        switch (action) {
          case "account":
            return jsonSuccess(getAccountInsights(requestData));
          case "refresh":
            runEngagementUpdateOnce();
            return jsonSuccess({ status: "started" });
          default:
            return jsonError(`Invalid action '${action}' for target 'insights'`, 400);
        }
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
          default:
            return jsonError(`Invalid action '${action}' for target 'threadsAuth'`, 400);
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
      default:
        return jsonError(`Invalid target '${target}' in GET request`, 400);
    }
  } catch (error: any) {
    Logger.log(`doGet error (action=${action}, target=${target}): ${error.message}`);
    return jsonError(error.message, 400);
  }
}
