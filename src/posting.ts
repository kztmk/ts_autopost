// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Bluesky / Threads を実処理する（スレッド連投 inReplyTo は Phase 6）。

import {
  readPostRows,
  movePostToPosted,
  markPostFailed,
  updatePostStatus,
} from "./api/postData";
import { postToBluesky } from "./api/blueskyAuth";
import { postToThreads, threadsPublishingLimitReached } from "./api/threadsAuth";
import { deletePostingTriggers } from "./api/triggers";
import { logErrorToSheet } from "./utils";
import { PostRow, Platform } from "./types";

const MAX_POSTS_PER_RUN = 20;
const LOCK_WAIT_MS = 0; // 取れなければ次のトリガー実行に任せる
const SUPPORTED_PLATFORMS: Platform[] = ["bluesky", "threads"];

function isDue(postSchedule: string, nowMs: number): boolean {
  if (!postSchedule) return true; // 予約日時なし = 即時
  const d = new Date(postSchedule);
  if (isNaN(d.getTime())) return true; // 不正な日時は投稿を試みる
  return d.getTime() <= nowMs;
}

function isQueued(row: PostRow): boolean {
  const status = String(row.status || ""); // シートのセルは空文字のこともある
  return (status === "queued" || status === "") && !row.postId;
}

/** Post を該当 Platform へ投稿し、公開後の投稿 ID を返す */
function publishPost(post: PostRow): string {
  if (post.platform === "bluesky") return postToBluesky(post.accountId, post.contents);
  if (post.platform === "threads") return postToThreads(post.accountId, post.contents);
  throw new Error(`Unsupported platform: ${post.platform}`);
}

/**
 * この Post を今回のランで「見送る」べきか（queued のまま残す）。
 * 現状は Threads のレート制限のみ。尽きていれば次回トリガーへ持ち越す。
 */
function shouldDefer(post: PostRow): boolean {
  if (post.platform === "threads" && threadsPublishingLimitReached(post.accountId)) {
    Logger.log(`Threads publishing limit reached for ${post.accountId}; deferring ${post.id}.`);
    return true;
  }
  return false;
}

/**
 * トリガーから呼ばれる投稿ループ。
 * 対象: status が queued/空・postId 未設定・スレッド子でない（inReplyTo 空）・時刻到来。
 *
 * 二重投稿ガード（x_Autopost の processing キャッシュ方式に相当）:
 *  - ScriptLock で並行実行を直列化（取れなければ即リターンし次回に任せる）
 *  - 投稿前に status を "processing" へ更新。isQueued は processing を対象外とするため、
 *    投稿成功後の Posted 移送が万一失敗しても、次回実行で同じ行を再投稿しない
 *    （processing のまま残った行は Errors シートとあわせて人が確認する）。
 */
export function autoPost(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log("autoPost: previous run still in progress. Skipping.");
    return;
  }

  try {
    const nowMs = Date.now();
    const due = readPostRows().filter(
      (r) =>
        isQueued(r) &&
        !r.inReplyTo &&
        SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1 &&
        isDue(r.postSchedule, nowMs)
    );

    let processed = 0;
    for (const post of due) {
      if (processed >= MAX_POSTS_PER_RUN) break;
      if (shouldDefer(post)) continue; // queued のまま次回へ

      processed++;
      updatePostStatus(post.id, "processing");
      try {
        const platformPostId = publishPost(post);
        try {
          movePostToPosted(post, platformPostId);
        } catch (moveError: any) {
          // 投稿自体は成功している。processing のまま残し、再投稿はしない。
          logErrorToSheet(
            {
              message: `投稿は成功したが Posted への移送に失敗: ${moveError.message}`,
              stack: moveError.stack,
              detail: `platform=${post.platform} accountId=${post.accountId} postId=${post.id} published=${platformPostId}`,
            },
            "autoPost/movePostToPosted"
          );
        }
      } catch (e: any) {
        markPostFailed(post.id, e.message);
        logErrorToSheet(
          {
            message: e.message,
            stack: e.stack,
            detail: `platform=${post.platform} accountId=${post.accountId} postId=${post.id}`,
          },
          `autoPost/${post.platform}`
        );
      }
    }

    // 実処理対象（対応 Platform・スレッド子でない）の queued が無ければトリガーを自動削除。
    // レート制限で見送った Threads 行は queued のまま残るので、その間はトリガーを維持し
    // 次回以降で再試行する（クォータは 24 時間で回復する）。
    const remaining = readPostRows().filter(
      (r) => isQueued(r) && !r.inReplyTo && SUPPORTED_PLATFORMS.indexOf(r.platform) !== -1
    );
    if (remaining.length === 0) {
      deletePostingTriggers();
    }
  } finally {
    lock.releaseLock();
  }
}

/** 【エディタ実行用】投稿ループを 1 回手動実行する（トリガーを待たずに検証したいとき） */
export function runAutoPostOnce(): void {
  autoPost();
  Logger.log("runAutoPostOnce 完了。Posted / Errors シートを確認してください。");
}
