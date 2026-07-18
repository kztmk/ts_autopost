import { VERSION } from "./constants";
// NOTE: initializeSheets（sheets.ts）はメニューから文字列名で呼ぶため import しない。
// import するとバンドル時に名前が衝突し initializeSheets2 にリネームされ、
// メニューの "initializeSheets" 呼び出しが解決できなくなる。

// ============================================================
// Web アプリのルーター（doGet / doPost）
//
// リクエストは ?target=<対象>&action=<操作> で分岐する
// （x_Autopost と同じ target/action 方式）。
//
// Phase 0 ではルーティングの骨格のみ。各 target のハンドラは後続 Phase で実装する:
//   - security        → Phase 1（HMAC Proxy 認証・setup code）
//   - blueskyAuth     → Phase 2
//   - threadsAuth     → Phase 3
//   - postData        → Phase 2/4
//   - trigger         → Phase 2
//
// Phase 1 で、下記 SECURITY マーカーの位置に assertProxyAuthorized を挿入する。
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
 * 本人確認コード生成メニューは Phase 1 で追加する。
 */
export function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("Autopost 連携")
    .addItem("シート初期化", "initializeSheets")
    .addToUi();
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

    // Phase 1: target === "security" && action === "initialize" を
    //          無認証のまま先に処理する（唯一の無認証 POST）。

    // SECURITY(Phase 1): ここに assertProxyAuthorized(e, action, target, requestData, "POST") を挿入し、
    //                    その後 requestData = stripAuthField(requestData) する。

    switch (target) {
      case "security":
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
    // 疎通確認用（無認証）。Phase 1 で security.status を追加する。
    if (target === "meta" && action === "version") {
      return jsonSuccess({ name: "autopost-threads-bluesky", version: VERSION });
    }

    // Phase 3: Threads OAuth の無認証コールバックルートをここに追加する
    //          （target/action ではなく ?code=... で判定。ADR 0003）。

    // SECURITY(Phase 1): ここに assertProxyAuthorized(e, action, target, {}, "GET") を挿入する。

    switch (target) {
      case "security":
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
