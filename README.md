# Autopost Threads/Bluesky（GAS バックエンド）

Threads と Bluesky への予約投稿を管理する Google Apps Script バックエンド。
フロントエンド（snake-sns をフォークした別アプリ）から **Firebase Functions を Proxy** として
HMAC 署名付きで操作される。X 用 GAS プロジェクト [`x_Autopost`] の姉妹プロジェクトで、
アーキテクチャを踏襲している。

- 用語の定義: [`CONTEXT.md`](./CONTEXT.md)
- 設計判断: [`docs/adr/`](./docs/adr/)（0001 フォーク採用 / 0002 1行=1配信 / 0003 BYO Meta アプリ）
- 全体の開発手順: [`docs/development-plan.md`](./docs/development-plan.md)

## 主な機能

- **Bluesky 投稿**（アプリパスワード方式、テキスト・画像・スレッド連投）
- **Threads 投稿**（BYO Meta アプリ + OAuth、テキスト・画像/カルーセル・スレッド連投）
- **クロスポスト**（1回の一括作成で複数プラットフォーム／アカウントへ配信）
- **スレッド連投**（`inReplyTo` 連鎖、親→子のトポロジカル順、親失敗時は再開可能）
- **画像対応**（Threads: 公開 URL 方式 / Bluesky: `uploadBlob` バイト転送 + MIME・サイズ検証）
- **エンゲージメント蓄積**（投稿単位の views/likes/replies/reposts/quotes/shares を日次で Posted に更新）
- **予約投稿トリガー**・**トークン自動延命**（Threads 長期トークン）・**アーカイブ**

## アーキテクチャ

```
フロントエンド(React/Firebase) ──HMAC署名──▶ Firebase Functions(proxy.ts) ──▶ この GAS Web アプリ
                                                                                    │
                                                     ┌──────────────────────────────┤
                                                Google スプレッドシート        Threads / Bluesky API
                                                (Posts/Posted/Errors)
```

- **ルーター**: `?target=<対象>&action=<操作>` で分岐（`src/main.ts` の `doGet`/`doPost`）。
- **Proxy 契約**（`src/security.ts`）: 署名対象 `timestamp.uid.action.target.stableStringify(body)` を
  HMAC-SHA256 → web-safe base64（パディング除去）。Functions 側 `proxy.ts` と 1 バイト単位で一致。
  `security.initialize`（無認証 POST・setup code 方式）と `security.status`（無認証 GET）、
  Threads OAuth コールバックのみが署名の例外。
- **データストア**: Google スプレッドシート。認証情報・トークン・proxySecret は PropertiesService。

### シート構成

| シート | 用途 | 主な列 |
|---|---|---|
| `Posts` | 予約キュー（1 行 = 1 配信） | id, platform, accountId, contents, mediaUrls, postSchedule, crossPostGroupId, inReplyTo, status, postId |
| `Posted` | 投稿済み + エンゲージメント | 上記 + postedAt, views, likes, replies, reposts, quotes, shares, insightsUpdatedAt |
| `Errors` | エラーログ | timestamp, context, message, stack, detail |

## API エンドポイント（target / action）

**POST**
- `blueskyAuth`: create / update / delete
- `threadsAuth`: create / update / delete / authorizeUrl
- `postData`: create / createMultiple / updateInReplyTo / delete
- `trigger`: create / delete / ensureMaintenance / deleteMaintenance / ensureEngagement / deleteEngagement
- `insights`: refresh（投稿単位の日次更新を手動起動）
- `archive`: run（body: source=Posted|Errors, filename）
- `security`: initialize（**無認証**・初回接続）

**GET**
- `blueskyAuth` / `threadsAuth` / `postData` / `postedData` / `errorData`: fetch
- `trigger`: status / `insights`: account（?platform=&accountId=）
- `security`: status（**無認証**・疎通確認）

## 開発

### 必要環境
- Node.js / npm、[`clasp`](https://github.com/google/clasp)（`clasp login` 済み）
- コンテナバインドの GAS プロジェクト（`.clasp.json` にスクリプト ID）

### コマンド
```bash
npm install
npm run typecheck   # tsc 型チェック
npm run build       # esbuild で 1 ファイルにバンドル → IIFE を剥がして dist/code.js
npm run push        # dist/code.js と appsscript.json を clasp push
npm run deploy      # build + push
```

### ビルドの仕組み
`src/**` を esbuild で 1 つの IIFE にバンドルし、`modify-codejs.js` でラッパーを剥がして
各トップレベル関数を GAS のグローバル関数として露出させる。
**関数名は全モジュールで一意にすること**（衝突すると esbuild がリネームし、
`doGet`/`doPost`/トリガーハンドラ等が GAS から解決できなくなる）。

### 運用上の注意
- **Web アプリ更新**: `clasp push` 後、`/exec` に反映するには「デプロイを管理 → 既存デプロイの新バージョン」
  で再デプロイする（URL 固定）。新規デプロイは URL が変わり Meta のリダイレクト URI 登録が壊れる。
- **トリガーの反映ラグ**: `clasp push` 直後の時間トリガーは旧コードを実行することがある（数分〜十数分）。
  即検証はエディタから `runAutoPostOnce` / `runEngagementUpdateOnce` を実行する。

## セットアップ手順（概要）

1. GAS プロジェクト作成 → `npm run push` でコードを反映 → Web アプリとしてデプロイ（実行=自分 / アクセス=全員）。
2. スプレッドシートのメニュー「Autopost 連携 → シート初期化」で Posts/Posted/Errors を作成。
3. フロント接続: メニュー「本人確認コードを生成」→ フロントで GAS URL + コードを入力し `security.initialize`。
4. Bluesky: アプリパスワードを発行して `blueskyAuth create`。
5. Threads: BYO Meta アプリ（Threads の使用事例）を作成しテスター承認・リダイレクト URI 登録 →
   `threadsAuth create` → `threadsAuth authorizeUrl` の URL を開いて認可（スコープに `threads_manage_replies` 必須）。

詳細は [`docs/development-plan.md`](./docs/development-plan.md) 参照。

## 関連リポジトリ

- `~/Documents/Devs/React/playground/x_Autopost` — アーキテクチャ踏襲元（X 用 GAS）
- `~/Documents/Devs/React/playground/autopost-frontend` — 操作元フロントエンド（snake-sns フォーク）
