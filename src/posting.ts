// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Phase 2 では Bluesky のみ実処理する（Threads は Phase 4、スレッド連投は Phase 6）。

import {
  readPostRows,
  movePostToPosted,
  markPostFailed,
  updatePostStatus,
} from "./api/postData";
import { postToBluesky } from "./api/blueskyAuth";
import { deletePostingTriggers } from "./api/triggers";
import { logErrorToSheet } from "./utils";
import { PostRow } from "./types";

const MAX_POSTS_PER_RUN = 20;
const LOCK_WAIT_MS = 0; // 取れなければ次のトリガー実行に任せる

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
      (r) => isQueued(r) && !r.inReplyTo && isDue(r.postSchedule, nowMs)
    );

    let processed = 0;
    for (const post of due) {
      if (processed >= MAX_POSTS_PER_RUN) break;

      // Threads は Phase 4 で実装。それまでは queued のまま残す。
      if (post.platform !== "bluesky") continue;

      processed++;
      updatePostStatus(post.id, "processing");
      try {
        const uri = postToBluesky(post.accountId, post.contents);
        try {
          movePostToPosted(post, uri);
        } catch (moveError: any) {
          // 投稿自体は成功している。processing のまま残し、再投稿はしない。
          logErrorToSheet(
            {
              message: `投稿は成功したが Posted への移送に失敗: ${moveError.message}`,
              stack: moveError.stack,
              detail: `platform=bluesky accountId=${post.accountId} postId=${post.id} uri=${uri}`,
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
            detail: `platform=bluesky accountId=${post.accountId} postId=${post.id}`,
          },
          "autoPost/bluesky"
        );
      }
    }

    // 実処理対象（bluesky・スレッド子でない）の queued が無ければトリガーを自動削除する。
    // Threads の queued はまだ残るため bluesky に限って判定（Phase 4 で見直す）。
    // inReplyTo 付きの子行は Phase 6 まで投稿対象外なので、判定からも除外する
    // （除外しないと子行が残る限りトリガーが空実行を続ける）。
    const remainingBluesky = readPostRows().filter(
      (r) => isQueued(r) && r.platform === "bluesky" && !r.inReplyTo
    );
    if (remainingBluesky.length === 0) {
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
