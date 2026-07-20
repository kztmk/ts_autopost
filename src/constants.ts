export const VERSION = "0.1.0";

/** 投稿先プラットフォーム種別（CONTEXT.md「Platform」） */
export const PLATFORMS = {
  THREADS: "threads",
  BLUESKY: "bluesky",
} as const;

/** シート名 */
export const SHEETS = {
  POSTS: "Posts", // 予約キュー（1 行 = 1 PlatformAccount 宛の 1 Post）
  POSTED: "Posted", // 投稿済み（+ エンゲージメント。Phase 7）
  ERRORS: "Errors", // エラーログ
} as const;

/**
 * 各シートの列定義（順序が列インデックスに対応する）。
 * ADR 0002: Post は常にちょうど 1 つの (platform, accountId) に紐付く。
 * media / engagement 列は v1 では未使用だが、後続 Phase のために予約する。
 */
export const HEADERS = {
  // Posts シート
  POST_HEADERS: [
    "id", // 0  UUID
    "createdAt", // 1  作成日時 (ISO)
    "platform", // 2  'threads' | 'bluesky'
    "accountId", // 3  投稿先 PlatformAccount
    "contents", // 4  本文
    "mediaUrls", // 5  画像 URL の JSON 配列（Phase 5 予約）
    "postSchedule", // 6  予約日時 (ISO)
    "crossPostGroupId", // 7  一括作成グループ（クロスポスト。ADR 0002）
    "inReplyTo", // 8  親 Post の内部 id（スレッド連投。Phase 6 予約）
    "status", // 9  'queued' | 'processing' | 'posted' | 'failed'
    "postId", // 10 公開後のプラットフォーム投稿 ID（Threads Media ID / Bluesky AT URI）
    "errorMessage", // 11 失敗時のエラー内容
  ] as const,

  // Posted シート（投稿済みの移送先 + エンゲージメント）
  POSTED_HEADERS: [
    "id", // 0
    "createdAt", // 1
    "postedAt", // 2  公開完了日時 (ISO)
    "platform", // 3
    "accountId", // 4
    "contents", // 5
    "mediaUrls", // 6
    "postSchedule", // 7
    "crossPostGroupId", // 8
    "inReplyTo", // 9
    "postId", // 10
    "views", // 11 以降 Phase 7 予約
    "likes", // 12
    "replies", // 13
    "reposts", // 14
    "quotes", // 15
    "shares", // 16
    "insightsUpdatedAt", // 17 エンゲージメント更新日時
  ] as const,

  // Errors シート
  ERROR_HEADERS: [
    "timestamp",
    "context",
    "message",
    "stack",
    "detail",
  ] as const,
} as const;
