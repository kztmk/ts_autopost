// Posted / Errors シートのアーカイブ。x_Autopost の archiveSheet を移植。
// 対象シートを Drive 上の別スプレッドシート「Autopost_Archive」へ新しいシートとしてコピーし、
// 元シートは削除する（次回アクセス時に ensureSheet がヘッダー付きで再作成する）。

import { SHEETS } from "../constants";

const ARCHIVE_FILE_NAME = "Autopost_Archive";
const ARCHIVABLE_SHEETS: string[] = [SHEETS.POSTED, SHEETS.ERRORS];

/**
 * @param source コピー元シート名（"Posted" または "Errors"）
 * @param filename アーカイブ先に作る新しいシート名
 */
export function archiveSheet(source: string, filename: string) {
  const sourceName = String(source || "").trim();
  if (ARCHIVABLE_SHEETS.indexOf(sourceName) === -1) {
    throw new Error(`Invalid source. Must be one of: ${ARCHIVABLE_SHEETS.join(", ")}.`);
  }
  const newSheetName = String(filename || "").trim();
  if (!newSheetName) {
    throw new Error("Missing required field: filename.");
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName(sourceName);
  if (!sourceSheet) {
    throw new Error(`Source sheet "${sourceName}" not found.`);
  }

  // アーカイブ用スプレッドシートを特定または作成
  let archiveSs: GoogleAppsScript.Spreadsheet.Spreadsheet;
  let isNew = false;
  const files = DriveApp.getFilesByName(ARCHIVE_FILE_NAME);
  if (files.hasNext()) {
    archiveSs = SpreadsheetApp.openById(files.next().getId());
  } else {
    archiveSs = SpreadsheetApp.create(ARCHIVE_FILE_NAME);
    isNew = true;
  }

  if (archiveSs.getSheetByName(newSheetName)) {
    throw new Error(`アーカイブ先に同名シートが既にあります: ${newSheetName}`);
  }

  const copied = sourceSheet.copyTo(archiveSs);
  copied.setName(newSheetName);
  SpreadsheetApp.flush();

  // 新規作成時に付く既定シートを掃除
  if (isNew) {
    const def = archiveSs.getSheetByName("シート1") || archiveSs.getSheetByName("Sheet1");
    if (def && archiveSs.getSheets().length > 1) {
      archiveSs.deleteSheet(def);
    }
  }

  // 元シートを削除（次回 ensureSheet で空のヘッダー付きシートが再作成される）
  ss.deleteSheet(sourceSheet);

  return {
    status: "success",
    source: sourceName,
    newSheetName,
    archiveFileId: archiveSs.getId(),
    archiveFileUrl: archiveSs.getUrl(),
  };
}
