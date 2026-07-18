# Autopost Threads/Bluesky

Threads と Bluesky への予約投稿を管理する GAS バックエンド。snake-sns（Torai）系のフロントエンド + Firebase Functions Proxy から HMAC 署名付きで操作される。x_Autopost（X 版）の姉妹プロジェクトであり、アーキテクチャを踏襲する。

## Language

**Platform（プラットフォーム）**:
投稿先サービスの種別。`threads` または `bluesky` の2値。
_Avoid_: SNS、サービス、ターゲット

**PlatformAccount（アカウント）**:
ユーザーが接続した投稿先アカウント。`(platform, accountId)` で一意に識別され、認証情報一式（Threads: OAuth トークン、Bluesky: ハンドル+アプリパスワード+JWT ペア）を持つ。両プラットフォームとも1ユーザーが複数持てる。
_Avoid_: プロフィール、認証情報（credentials は PlatformAccount の属性であって同義語ではない）

**Post（投稿）**:
ちょうど1つの PlatformAccount 宛の1配信。シート上の1行に対応し、ステータス・エラー・公開後の投稿ID（Threads Media ID / Bluesky AT URI）を行単位で完結して持つ。
_Avoid_: コンテンツ（本文そのものは Post の属性）、配信

**Cross-post（クロスポスト / 同時投稿）**:
同じ内容を複数の PlatformAccount へ投稿するために、フロントエンドが複数の Post を一括作成する操作。GAS 側に「複数プラットフォームへ同時に撃つ」単一機能は存在しない（旧ドラフトの `postToAll` は廃止）。
_Avoid_: 統合投稿、postToAll

**Thread（スレッド連投）**:
同一の PlatformAccount 宛の複数の Post が `inReplyTo` で連結された自己リプライの連鎖。クロスポストされたスレッドは、プラットフォームごとに独立した連鎖になる（連鎖が PlatformAccount をまたぐことはない）。
_Avoid_: ツリー、連続投稿

**Proxy 契約（Proxy Contract）**:
Firebase Functions と GAS の間の署名付きリクエスト規約。`timestamp.uid.action.target.stableJson` を HMAC-SHA256 署名する snake-sns / x_Autopost と同一のもの。

**Setup Code（セットアップコード）**:
スプレッドシートのメニューから生成する一回限りの本人確認コード。`security.initialize` で GAS と Firebase UID を紐付け、`proxySecret` を発行する。

**OAuth コールバックルート**:
GAS `doGet` 上の無認証例外ルート。ユーザー自身の Meta アプリ（BYO）からの Threads 認可リダイレクトを受け、`state` で PlatformAccount への紐付けと CSRF 検証を行う。Proxy 契約の署名対象外である点で他の全ルートと異なる。
