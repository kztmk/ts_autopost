// 投稿ループ（トリガーハンドラ autoPost）。
// Posts シートを走査し、時刻の来た Post を各 Platform へ投稿して Posted へ移送する。
// Bluesky / Threads を実処理し、スレッド連投（inReplyTo 連鎖）にも対応する。

import {
  readPostRows,
  movePostToPosted,
  markPostFailed,
  updatePostStatus,
  fetchPostedData,
} from "./api/postData";
import { postToBluesky, getBlueskyReplyRef } from "./api/blueskyAuth";
import { postToThreads, getThreadsRemainingQuota } from "./api/threadsAuth";
import { deletePostingTriggers } from "./api/triggers";
import { logErrorToSheet } from "./utils";
import { PostRow, Platform } from "./types";

const MAX_POSTS_PER_RUN = 20;
const LOCK_WAIT_MS = 0; // 取れなければ次のトリガー実行に任せる
// Threads クォータの安全マージン。「上限近接時は見送り」（development-plan Phase 4）の実装。
// 残枠がこの値以下になったら投稿せず次回へ持ち越す（チェック後〜publish 間の枯渇レース対策）。
const THREADS_QUOTA_SAFETY_MARGIN = 2;
// inReplyTo 連鎖をたどる上限（循環・異常データからの脱出弁）
const MAX_CHAIN_DEPTH = 100;

// ---- Platform ディスパッチ ----
// platform ごとの分岐を 1 箇所に集約する（Phase 4 レビュー指摘の対応）。
// クォータ判定（ThreadsQuotaTracker）は Threads 固有の関心事なので別に持つ。

interface PlatformHandler {
  /** Post を公開し、公開後のプラットフォーム投稿 ID を返す */
  publish(post: PostRow, mediaUrls: string[], parentPostId?: string): string;
}

const PLATFORM_HANDLERS: { [P in Platform]: PlatformHandler } = {
  bluesky: {
    publish: (post, mediaUrls, parentPostId) =>
      postToBluesky(
        post.accountId,
        post.contents,
        mediaUrls,
        parentPostId ? getBlueskyReplyRef(post.accountId, parentPostId) : undefined
      ),
  },
  threads: {
    publish: (post, mediaUrls, parentPostId) =>
      postToThreads(post.accountId, post.contents, mediaUrls, parentPostId),
  },
};

/** シート上の不正値（手編集等）を弾くガード。対応 Platform はハンドラ表から導出する */
function isSupportedPlatform(value: any): value is Platform {
  return Object.prototype.hasOwnProperty.call(PLATFORM_HANDLERS, String(value));
}

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
 * mediaUrls 列（JSON 配列文字列）を厳格にパースする。
 * 破損 JSON を [] に黙殺すると「画像付きのはずが画像なしで成功」する
 * サイレント経路になるため、不正なら throw して failed + Errors 記録に乗せる。
 */
function parseMediaUrls(raw: string): string[] {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    throw new Error(`mediaUrls が不正な JSON です: ${s}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`mediaUrls は JSON 配列である必要があります: ${s}`);
  }
  return parsed.map((u) => String(u));
}

/**
 * Threads クォータのラン内トラッカー。
 * threads_publishing_limit API はアカウントごとに 1 ラン 1 回だけ呼び、
 * 以降はラン内で消費数を差し引いて判定する（行ごとの API 呼び出しを避ける）。
 */
class ThreadsQuotaTracker {
  private remaining: { [accountId: string]: number } = {};

  /** この Post を見送るべきか（残枠がマージン以下）。Threads 以外は常に false */
  shouldDefer(post: PostRow): boolean {
    if (post.platform !== "threads") return false;
    if (!(post.accountId in this.remaining)) {
      this.remaining[post.accountId] = getThreadsRemainingQuota(post.accountId);
    }
    if (this.remaining[post.accountId] <= THREADS_QUOTA_SAFETY_MARGIN) {
      Logger.log(
        `Threads quota near limit for ${post.accountId} (remaining=${this.remaining[post.accountId]}); deferring ${post.id}.`
      );
      return true;
    }
    return false;
  }

  /** 投稿を 1 件消費したことを記録する */
  consume(post: PostRow): void {
    if (post.platform === "threads" && post.accountId in this.remaining) {
      this.remaining[post.accountId]--;
    }
  }
}

/**
 * due の Post を「親→子」の順に並べる（トポロジカルソート）。
 * バッチ内に親がいる子は、その親より後に処理されるようにする。
 * 深さ = due 内をたどれる祖先の数。祖先が既に Posted 済み（due 外）なら深さに数えない。
 */
function orderByReplyChain(due: PostRow[]): PostRow[] {
  const byId: { [id: string]: PostRow } = {};
  due.forEach((p) => (byId[p.id] = p));
  const depthCache: { [id: string]: number } = {};
  function depth(p: PostRow, seen: { [id: string]: boolean }): number {
    if (p.id in depthCache) return depthCache[p.id];
    if (!p.inReplyTo || !(p.inReplyTo in byId) || seen[p.id]) {
      depthCache[p.id] = 0;
      return 0;
    }
    seen[p.id] = true; // 循環参照ガード
    const d = 1 + depth(byId[p.inReplyTo], seen);
    depthCache[p.id] = d;
    return d;
  }
  return due.slice().sort((a, b) => depth(a, {}) - depth(b, {}));
}

type ParentResolution =
  | { status: "root" }
  | { status: "ready"; parentPostId: string }
  | { status: "wait" }
  | { status: "broken"; reason: string };

/** 公開済み親の参照情報（Posted 事前ロード + ラン内投稿分） */
interface PublishedRef {
  postId: string;
  platform: Platform;
  accountId: string;
}

/**
 * 親 Post の解決を担うラン内キャッシュ。
 * - published: Posted シートの事前ロード + このランで投稿した分を逐次追加
 * - pending: Posts シートの全行（未投稿・失敗の親の状態参照用）
 *
 * セマンティクス（CONTEXT.md「Thread」/ development-plan Phase 6）:
 * - 親子は同一 PlatformAccount（platform + accountId）でなければならない → 不一致は broken
 * - 親が Posts に残っている（queued/processing/failed）間は wait
 *   （failed でも wait: 親を修正して re-queue すれば子は自動再開する。「再開できる」の担保）
 * - 親がどこにも無い（削除された）場合と循環参照は broken（子を failed 化）
 */
class ParentResolver {
  private published: { [internalId: string]: PublishedRef } = {};
  private pending: { [internalId: string]: PostRow } = {};

  constructor(allPosts: PostRow[], postedRows: any[]) {
    allPosts.forEach((p) => (this.pending[p.id] = p));
    postedRows.forEach((r) => {
      if (r.id && r.postId) {
        this.published[r.id] = {
          postId: r.postId,
          platform: r.platform,
          accountId: r.accountId,
        };
      }
    });
  }

  /** このランで投稿した Post を記録する（同一ラン内で子が親を参照できるように） */
  recordPublished(post: PostRow, platformPostId: string): void {
    this.published[post.id] = {
      postId: platformPostId,
      platform: post.platform,
      accountId: post.accountId,
    };
  }

  resolve(post: PostRow): ParentResolution {
    if (!post.inReplyTo) return { status: "root" };

    // 循環検出: pending 内の祖先チェーンをたどり、再訪または深さ超過で broken
    const seen: { [id: string]: boolean } = {};
    let cursor = post.inReplyTo;
    for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
      if (seen[cursor] || cursor === post.id) {
        return { status: "broken", reason: `inReplyTo が循環しています（${post.id} → … → ${cursor}）` };
      }
      seen[cursor] = true;
      const next = this.pending[cursor];
      if (!next || !next.inReplyTo) break;
      cursor = next.inReplyTo;
    }

    const parentId = post.inReplyTo;
    const published = this.published[parentId];
    if (published) {
      if (published.platform !== post.platform || published.accountId !== post.accountId) {
        return {
          status: "broken",
          reason:
            `親(${parentId})と PlatformAccount が異なります` +
            `（親=${published.platform}/${published.accountId} 子=${post.platform}/${post.accountId}）`,
        };
      }
      return { status: "ready", parentPostId: published.postId };
    }

    const pendingParent = this.pending[parentId];
    if (pendingParent) {
      if (
        pendingParent.platform !== post.platform ||
        pendingParent.accountId !== post.accountId
      ) {
        return {
          status: "broken",
          reason:
            `親(${parentId})と PlatformAccount が異なります` +
            `（親=${pendingParent.platform}/${pendingParent.accountId} 子=${post.platform}/${post.accountId}）`,
        };
      }
      // queued / processing / failed のいずれでも wait。
      // failed の親は修正・re-queue されれば次回以降のランで子が自動再開する。
      return { status: "wait" };
    }

    return { status: "broken", reason: `親(${parentId})が見つかりません` };
  }
}

/**
 * トリガーから呼ばれる投稿ループ。
 * 対象: status が queued/空・postId 未設定・対応 Platform・時刻到来（スレッド子行も含む）。
 *
 * スレッド連投:
 *  - 親（inReplyTo 先）が投稿済みになってから子を投稿する（親→子のトポロジカル順）。
 *  - 親が未投稿・失敗中の間は子は見送り（queued 維持）、親の解決後に自動再開。
 *  - 親が削除済み・PlatformAccount 不一致・循環参照の場合は子を failed にする。
 *
 * 二重投稿ガード:
 *  - ScriptLock で並行実行を直列化（取れなければ即リターン）。
 *  - 投稿前に status を "processing" にし、Posted 移送失敗時も再投稿しない。
 */
export function autoPost(): void {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log("autoPost: previous run still in progress. Skipping.");
    return;
  }

  try {
    const nowMs = Date.now();
    const allPosts = readPostRows();
    const due = orderByReplyChain(
      allPosts.filter(
        (r) => isQueued(r) && isSupportedPlatform(r.platform) && isDue(r.postSchedule, nowMs)
      )
    );

    const parentResolver = new ParentResolver(allPosts, fetchPostedData());
    const quotaTracker = new ThreadsQuotaTracker();
    let processed = 0;

    for (const post of due) {
      if (processed >= MAX_POSTS_PER_RUN) break;

      const parent = parentResolver.resolve(post);
      if (parent.status === "wait") continue; // queued のまま次回へ（親の解決待ち）
      if (parent.status === "broken") {
        markPostFailed(post.id, parent.reason);
        logErrorToSheet(
          { message: parent.reason, detail: `platform=${post.platform} postId=${post.id}` },
          "autoPost/thread"
        );
        continue;
      }
      if (quotaTracker.shouldDefer(post)) continue; // queued のまま次回へ

      processed++;
      updatePostStatus(post.id, "processing");
      try {
        const parentPostId = parent.status === "ready" ? parent.parentPostId : undefined;
        const mediaUrls = parseMediaUrls(post.mediaUrls);
        const platformPostId = PLATFORM_HANDLERS[post.platform].publish(
          post,
          mediaUrls,
          parentPostId
        );
        quotaTracker.consume(post);
        parentResolver.recordPublished(post, platformPostId);
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

    // 対応 Platform の queued が無ければトリガーを自動削除。
    // レート制限で見送った Threads 行や、親待ちの子行が queued のまま残る間はトリガーを維持する。
    const remaining = readPostRows().filter(
      (r) => isQueued(r) && isSupportedPlatform(r.platform)
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
