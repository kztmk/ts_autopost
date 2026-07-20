// Posted / Errors シートのアーカイブ。x_Autopost の archiveSheet を移植。
// 対象シートを Drive 上の別スプレッドシート「Autopost_Archive」へ新しいシートとしてコピーし、
// 元シートは削除する（次回アクセス時に ensureSheet がヘッダー付きで再作成する）。

import { SHEETS } from "../constants";

const ARCHIVE_FILE_NAME = "Autopost_Archive";
const ARCHIVE_FILE_ID_PROP = "archive_spreadsheet_id"; // 作成したファイル ID を記憶する
const ARCHIVABLE_SHEETS: string[] = [SHEETS.POSTED, SHEETS.ERRORS];
// Google スプレッドシートのシート名で使えない文字
const INVALID_SHEET_NAME_CHARS = /[:\\/?*\[\]]/;
const MAX_SHEET_NAME_LENGTH = 100;

/** アーカイブ用スプレッドシートを取得または作成する（ID を Script Properties に記憶して名前検索に頼らない） */
function getOrCreateArchiveSpreadsheet(): {
  ss: GoogleAppsScript.Spreadsheet.Spreadsheet;
  isNew: boolean;
} {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty(ARCHIVE_FILE_ID_PROP);
  if (savedId) {
    try {
      return { ss: SpreadsheetApp.openById(savedId), isNew: false };
    } catch (e) {
      // 記憶していた ID が無効（削除等）なら作り直す
      Logger.log(`archive: saved id ${savedId} を開けないため再作成します。`);
    }
  }
  const ss = SpreadsheetApp.create(ARCHIVE_FILE_NAME);
  props.setProperty(ARCHIVE_FILE_ID_PROP, ss.getId());
  return { ss, isNew: true };
}

/**
 * @param source コピー元シート名（"Posted" または "Errors"）
 * @param filename アーカイブ先に作る新しいシート名
 *
 * autoPost / updateAllEngagement と同じ ScriptLock を取り、コピー〜元シート削除の間に
 * 新しい投稿が追記されて取りこぼされることを防ぐ。
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
  if (newSheetName.length > MAX_SHEET_NAME_LENGTH) {
    throw new Error(`filename が長すぎます（${MAX_SHEET_NAME_LENGTH} 文字以内）: ${newSheetName}`);
  }
  if (INVALID_SHEET_NAME_CHARS.test(newSheetName)) {
    throw new Error(`filename に使えない文字が含まれています（: \\ / ? * [ ] は不可）: ${newSheetName}`);
  }

  // autoPost / updateAllEngagement と同じ ScriptLock を取り、コピー〜元シート削除の間に
  // Posted への投稿追記・エンゲージメント更新が発生して取りこぼされるのを防ぐ。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error("アーカイブ処理のロックを取得できませんでした。しばらく後に再試行してください。");
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sourceSheet = ss.getSheetByName(sourceName);
    if (!sourceSheet) {
      throw new Error(`Source sheet "${sourceName}" not found.`);
    }

    const { ss: archiveSs, isNew } = getOrCreateArchiveSpreadsheet();
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
  } finally {
    lock.releaseLock();
  }
}
