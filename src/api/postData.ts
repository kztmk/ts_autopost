// Posts / Posted / Errors シートの CRUD と、投稿ループが使う低レベルヘルパ。
// スキーマは constants.ts HEADERS に従う（ADR 0002: 1 行 = 1 PlatformAccount 宛の 1 Post）。

import { SHEETS, HEADERS } from "../constants";
import { ensureSheet } from "../sheets";
import { PostInput, PostRow, Platform } from "../types";
import { newId, requireNonEmptyString } from "../utils";

const VALID_PLATFORMS: Platform[] = ["threads", "bluesky"];

function indexMap(headers: readonly string[]): { [key: string]: number } {
  const map: { [key: string]: number } = {};
  headers.forEach((h, i) => (map[h] = i));
  return map;
}

/** シートの全データ行をオブジェクト（+ シート行番号 __row）として読む共通ヘルパ */
function readSheetRows(sheetName: string, headers: readonly string[]): any[] {
  const { sheet } = ensureSheet(sheetName, headers);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const map = indexMap(headers);
  const rows: any[] = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj: any = { __row: i + 1 };
    headers.forEach((h) => (obj[h] = row[map[h]] ?? ""));
    rows.push(obj);
  }
  return rows;
}

/** Posts シートの全行をオブジェクト（+ シート行番号 __row）で返す */
export function readPostRows(): Array<PostRow & { __row: number }> {
  return readSheetRows(SHEETS.POSTS, HEADERS.POST_HEADERS).filter((r) => r.id);
}

/** Posts シートの全 Post を返す（API 用、__row は除く） */
export function fetchPosts(): PostRow[] {
  return readPostRows().map((r) => {
    const { __row, ...post } = r as any;
    return post as PostRow;
  });
}

function buildPostRow(input: PostInput, groupId: string): PostRow {
  const platform = normalizePlatform(input.platform);
  const accountId = String(input.accountId || "").trim();
  const contents = String(input.contents ?? "");
  if (!accountId) throw new Error("Missing required field: accountId.");
  if (!contents) throw new Error("Missing required field: contents.");

  return {
    id: newId(),
    createdAt: new Date().toISOString(),
    platform,
    accountId,
    contents,
    mediaUrls: input.mediaUrls && input.mediaUrls.length ? JSON.stringify(input.mediaUrls) : "",
    postSchedule: input.postSchedule ? String(input.postSchedule) : "",
    crossPostGroupId: input.crossPostGroupId ? String(input.crossPostGroupId) : groupId,
    inReplyTo: input.inReplyTo ? String(input.inReplyTo) : "",
    status: "queued",
    postId: "",
    errorMessage: "",
  };
}

function normalizePlatform(value: any): Platform {
  const p = String(value || "").trim().toLowerCase();
  if (VALID_PLATFORMS.indexOf(p as Platform) === -1) {
    throw new Error(`Invalid platform: '${value}'. Must be one of ${VALID_PLATFORMS.join(", ")}.`);
  }
  return p as Platform;
}

function appendPostRow(post: PostRow): void {
  const { sheet } = ensureSheet(SHEETS.POSTS, HEADERS.POST_HEADERS);
  const row = HEADERS.POST_HEADERS.map((h) => (post as any)[h] ?? "");
  sheet.appendRow(row);
}

/** 1 件の Post を作成する */
export function createPost(input: PostInput): PostRow {
  const post = buildPostRow(input, newId());
  appendPostRow(post);
  return post;
}

/**
 * 複数の Post を一括作成する（クロスポスト）。
 * crossPostGroupId 未指定の Post には、このバッチ共通の groupId を割り当てる。
 */
export function createMultiplePosts(inputs: PostInput[]): PostRow[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("posts must be a non-empty array.");
  }
  const groupId = newId();
  return inputs.map((input) => {
    const post = buildPostRow(input, groupId);
    appendPostRow(post);
    return post;
  });
}

/** id 一致の Posts 行を削除する（降順に削除して行ズレを防ぐ）。削除件数を返す */
export function deletePostsByIds(ids: string[]): number {
  if (!ids || ids.length === 0) return 0;
  const idSet: { [id: string]: true } = {};
  ids.forEach((id) => (idSet[String(id)] = true));
  const targets = readPostRows()
    .filter((r) => idSet[String(r.id)])
    .map((r) => r.__row)
    .sort((a, b) => b - a);
  const { sheet } = ensureSheet(SHEETS.POSTS, HEADERS.POST_HEADERS);
  targets.forEach((rowIndex) => sheet.deleteRow(rowIndex));
  return targets.length;
}

/** 1 件の Post を削除する（API 用） */
export function deletePost(data: any) {
  const id = String(data?.id || "").trim();
  if (!id) throw new Error("Missing required field: id.");
  const deleted = deletePostsByIds([id]);
  return { id, deleted: deleted > 0 };
}

/** id 一致の Posts 行の status（と任意で errorMessage）を更新する */
export function updatePostStatus(id: string, status: string, errorMessage?: string): void {
  const { sheet } = ensureSheet(SHEETS.POSTS, HEADERS.POST_HEADERS);
  const map = indexMap(HEADERS.POST_HEADERS);
  const target = readPostRows().find((r) => String(r.id) === String(id));
  if (!target) return;
  sheet.getRange(target.__row, map["status"] + 1).setValue(status);
  if (errorMessage !== undefined) {
    sheet.getRange(target.__row, map["errorMessage"] + 1).setValue(errorMessage);
  }
}

/** id 一致の Posts 行を failed にし、エラーを記録する */
export function markPostFailed(id: string, errorMessage: string): void {
  updatePostStatus(id, "failed", errorMessage);
}

/**
 * スレッド連投の親子関係を設定する（フロントが createMultiple 後に呼ぶ）。
 * updates: [{ id, inReplyTo }]。inReplyTo は親 Post の内部 id（空文字でルート化）。
 *
 * リンク時検証（CONTEXT.md「Thread」: 連鎖は同一 PlatformAccount 内に限る）:
 * - 自己参照の拒否
 * - 親の存在（Posts または Posted）と PlatformAccount（platform + accountId）一致
 * - 適用後の Posts 内で循環しないこと
 */
export function updateInReplyTo(updates: Array<{ id: string; inReplyTo: string }>): {
  updated: number;
} {
  if (!Array.isArray(updates) || updates.length === 0) {
    throw new Error("updates must be a non-empty array of { id, inReplyTo }.");
  }
  const { sheet } = ensureSheet(SHEETS.POSTS, HEADERS.POST_HEADERS);
  const map = indexMap(HEADERS.POST_HEADERS);
  const rows = readPostRows();
  const rowById: { [id: string]: PostRow & { __row: number } } = {};
  rows.forEach((r) => (rowById[String(r.id)] = r));
  const postedById: { [id: string]: any } = {};
  fetchPostedData().forEach((r: any) => {
    if (r.id) postedById[String(r.id)] = r;
  });

  // 事前検証（1 件でも不正があれば何も書き込まない）
  const applied: { [id: string]: string } = {}; // 適用後の inReplyTo（循環検査用）
  updates.forEach((u) => {
    const id = requireNonEmptyString(u?.id, "id");
    const parentId = String(u?.inReplyTo ?? "").trim();
    const target = rowById[id];
    if (!target) {
      throw new Error(`Post not found in Posts: ${id}`);
    }
    if (!parentId) {
      applied[id] = ""; // ルート化
      return;
    }
    if (parentId === id) {
      throw new Error(`inReplyTo が自己参照しています: ${id}`);
    }
    const parent = rowById[parentId] || postedById[parentId];
    if (!parent) {
      throw new Error(`親 Post が見つかりません（Posts/Posted とも）: ${parentId}`);
    }
    if (parent.platform !== target.platform || parent.accountId !== target.accountId) {
      throw new Error(
        `親子の PlatformAccount が一致しません` +
          `（親=${parent.platform}/${parent.accountId} 子=${target.platform}/${target.accountId}）`
      );
    }
    applied[id] = parentId;
  });

  // 適用後の Posts 内で循環しないか（Posted 済みの親は終端なので循環し得ない）
  const effectiveParent = (id: string): string => (id in applied ? applied[id] : rowById[id]?.inReplyTo || "");
  Object.keys(applied).forEach((startId) => {
    const seen: { [id: string]: boolean } = {};
    let cursor = startId;
    while (cursor && rowById[cursor]) {
      if (seen[cursor]) {
        throw new Error(`inReplyTo が循環しています: ${startId} から到達`);
      }
      seen[cursor] = true;
      cursor = effectiveParent(cursor);
    }
  });

  let updated = 0;
  Object.keys(applied).forEach((id) => {
    const target = rowById[id];
    sheet.getRange(target.__row, map["inReplyTo"] + 1).setValue(applied[id]);
    updated++;
  });
  return { updated };
}

/**
 * 投稿成功した Post を Posted シートへ移送する（append → Posts から削除）。
 * @param post 対象の Post
 * @param postId 公開後のプラットフォーム投稿 ID（Threads Media ID / Bluesky AT URI）
 */
export function movePostToPosted(post: PostRow, postId: string): void {
  const { sheet: posted } = ensureSheet(SHEETS.POSTED, HEADERS.POSTED_HEADERS);
  const now = new Date().toISOString();
  const source: any = { ...post, postedAt: now, postId };
  const row = HEADERS.POSTED_HEADERS.map((h) => source[h] ?? "");
  posted.appendRow(row);
  deletePostsByIds([post.id]);
}

function stripRowNumber(rows: any[]): any[] {
  return rows.map((r) => {
    const { __row, ...rest } = r;
    return rest;
  });
}

/** Posted シートの全行を返す（API 用） */
export function fetchPostedData(): any[] {
  return stripRowNumber(readSheetRows(SHEETS.POSTED, HEADERS.POSTED_HEADERS));
}

/** Posted シートの全行を返す（+ シート行番号 __row。エンゲージメント更新用） */
export function readPostedRows(): any[] {
  return readSheetRows(SHEETS.POSTED, HEADERS.POSTED_HEADERS);
}

/**
 * Posted シートの指定 id 行にエンゲージメントと更新日時を書き込む。
 * @param rowIndex 対象のシート行番号（readPostedRows の __row）
 */
export function writePostedEngagement(
  rowIndex: number,
  eng: { views: number; likes: number; replies: number; reposts: number; quotes: number; shares: number }
): void {
  const { sheet } = ensureSheet(SHEETS.POSTED, HEADERS.POSTED_HEADERS);
  const map = indexMap(HEADERS.POSTED_HEADERS);
  // views〜shares は連続列なのでまとめて書き、更新日時を別途書く
  sheet
    .getRange(rowIndex, map["views"] + 1, 1, 6)
    .setValues([[eng.views, eng.likes, eng.replies, eng.reposts, eng.quotes, eng.shares]]);
  sheet.getRange(rowIndex, map["insightsUpdatedAt"] + 1).setValue(new Date().toISOString());
}

/** Errors シートの全行を返す（API 用） */
export function fetchErrorData(): any[] {
  return stripRowNumber(readSheetRows(SHEETS.ERRORS, HEADERS.ERROR_HEADERS));
}
