import { SHEETS, HEADERS } from "./constants";

/**
 * Posts / Posted / Errors シートを作成し、ヘッダー行を整える。
 * 既存シートは削除せず、ヘッダーが空の場合のみ書き込む（データ保護）。
 * スプレッドシートメニュー「Autopost 連携 → シート初期化」から実行できる。
 */
export function initializeSheets(): { created: string[]; ensured: string[] } {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      "アクティブなスプレッドシートが見つかりません。コンテナバインドの GAS プロジェクトから実行してください。"
    );
  }

  const created: string[] = [];
  const ensured: string[] = [];

  const specs: Array<{ name: string; headers: readonly string[] }> = [
    { name: SHEETS.POSTS, headers: HEADERS.POST_HEADERS },
    { name: SHEETS.POSTED, headers: HEADERS.POSTED_HEADERS },
    { name: SHEETS.ERRORS, headers: HEADERS.ERROR_HEADERS },
  ];

  specs.forEach((spec) => {
    let sheet = ss.getSheetByName(spec.name);
    if (!sheet) {
      sheet = ss.insertSheet(spec.name);
      created.push(spec.name);
    } else {
      ensured.push(spec.name);
    }
    if (sheet.getLastRow() === 0) {
      sheet
        .getRange(1, 1, 1, spec.headers.length)
        .setValues([spec.headers as string[]])
        .setFontWeight("bold");
      sheet.setFrozenRows(1);
    }
  });

  Logger.log(
    `initializeSheets 完了。作成: [${created.join(", ")}] / 既存: [${ensured.join(", ")}]`
  );
  return { created, ensured };
}
