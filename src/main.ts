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

// ============================================================
// Web アプリのルーター（doGet / doPost）
//
// リクエストは ?target=<対象>&action=<操作> で分岐する
// （x_Autopost と同じ target/action 方式）。
//
// security 以外の target のハンドラは後続 Phase で実装する:
//   - blueskyAuth     → Phase 2
//   - threadsAuth     → Phase 3
//   - postData        → Phase 2/4
//   - trigger         → Phase 2
// ============================================================

class NotImplementedError extends Error {
  constructor(target: string, action: string) {
    super(`Not implemented yet: target='${target}', action='${action}'`);
    this.name = "NotImplementedError";
  }
}

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
      case "threadsAuth":
      case "postData":
      case "trigger":
        throw new NotImplementedError(target, action);
      default:
        return jsonError(`Invalid target '${target}'`, 400);
    }
  } catch (error: any) {
    Logger.log(`doPost error (action=${action}, target=${target}): ${error.message}`);
    const code = error instanceof NotImplementedError ? 501 : 400;
    return jsonError(error.message, code);
  }
}

/**
 * GET リクエストの処理。
 */
export function doGet(e: any): GoogleAppsScript.Content.TextOutput {
  const action = e?.parameter?.action || "";
  const target = e?.parameter?.target || "";

  try {
    // security.status は唯一の無認証 GET（疎通確認・初期化状態の確認）。
    if (target === "security" && action === "status") {
      return jsonSuccess(getSecurityStatus());
    }

    // Phase 3: Threads OAuth の無認証コールバックルートをここに追加する
    //          （target/action ではなく ?code=... で判定。ADR 0003）。

    // これ以降はすべて署名検証を要求する。認証失敗は 401 に確定させる。
    try {
      assertProxyAuthorized(e, action, target, {}, "GET");
    } catch (authError: any) {
      Logger.log(`doGet auth rejected (action=${action}, target=${target}): ${authError.message}`);
      return jsonError(authError.message, 401);
    }

    switch (target) {
      case "blueskyAuth":
      case "threadsAuth":
      case "postData":
      case "postedData":
      case "errorData":
      case "trigger":
        throw new NotImplementedError(target, action);
      default:
        return jsonError(`Invalid target '${target}' in GET request`, 400);
    }
  } catch (error: any) {
    Logger.log(`doGet error (action=${action}, target=${target}): ${error.message}`);
    const code = error instanceof NotImplementedError ? 501 : 400;
    return jsonError(error.message, code);
  }
}
