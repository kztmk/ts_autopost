import { SHEETS, HEADERS } from "./constants";

/**
 * 指定名のシートを取得し、無ければ作成する。
 * ヘッダー行が空の場合のみ書き込む（既存データ保護）。
 */
export function ensureSheet(
  name: string,
  headers: readonly string[]
): { sheet: GoogleAppsScript.Spreadsheet.Sheet; created: boolean } {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      "アクティブなスプレッドシートが見つかりません。コンテナバインドの GAS プロジェクトから実行してください。"
    );
  }

  let sheet = ss.getSheetByName(name);
  const created = !sheet;
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, headers.length)
      .setValues([headers as string[]])
      .setFontWeight("bold");
    sheet.setFrozenRows(1);
  }
  return { sheet, created };
}

/**
 * Posts / Posted / Errors シートを作成し、ヘッダー行を整える。
 * スプレッドシートメニュー「Autopost 連携 → シート初期化」から実行できる。
 */
export function initializeSheets(): { created: string[]; ensured: string[] } {
  const created: string[] = [];
  const ensured: string[] = [];

  const specs: Array<{ name: string; headers: readonly string[] }> = [
    { name: SHEETS.POSTS, headers: HEADERS.POST_HEADERS },
    { name: SHEETS.POSTED, headers: HEADERS.POSTED_HEADERS },
    { name: SHEETS.ERRORS, headers: HEADERS.ERROR_HEADERS },
  ];

  specs.forEach((spec) => {
    const result = ensureSheet(spec.name, spec.headers);
    (result.created ? created : ensured).push(spec.name);
  });

  Logger.log(
    `initializeSheets 完了。作成: [${created.join(", ")}] / 既存: [${ensured.join(", ")}]`
  );
  return { created, ensured };
}
