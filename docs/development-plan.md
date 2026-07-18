# 開発手順書 — Threads/Bluesky 自動投稿システム v1

前提: `CONTEXT.md`（用語集）と `docs/adr/0001〜0003` の合意事項に基づく。

- GAS: このリポジトリに x_Autopost 踏襲で新規作成（TS + esbuild、target/action ルーティング、HMAC Proxy 認証、Sheets DB）
- フロント: snake-sns（Torai）フォークの別アプリ + 新 Firebase プロジェクト
- v1 スコープ: 単発予約投稿（テキスト+画像）、スレッド連投、投稿単位エンゲージメントの日次シート蓄積

各 Phase は「開発作業（Claude が実施）」と「あなたの作業（手作業が必要なもの）」に分かれる。
**あなたの作業のうち ⏳ 印は待ち時間が発生しうるもの**（審査・承認など）なので、早めに着手してよい。

## Phase 一覧

| Phase | 内容 | あなたの作業の重さ |
|---|---|---|
| 0 | 開発基盤（リポジトリ・GASプロジェクト） | 小 |
| 1 | Proxy 契約・セキュリティ基盤 | 小 |
| 2 | Bluesky 縦貫通（テキスト投稿） | 小 |
| 3 | Threads 認証（OAuth） | **大** |
| 4 | Threads 投稿（テキスト） | 小 |
| 5 | 画像対応 | 小 |
| 6 | スレッド連投 | 小 |
| 7 | エンゲージメント蓄積 | 小 |
| 8 | フロントエンド基盤（snake-sns フォーク） | 中 |
| 9 | フロント UI（アカウント管理・投稿・画像） | 小 |
| 10 | E2E 検証・運用整備 | 中 |

先行着手できるあなたの作業: Phase 3 の Meta アプリ作成（⏳ テスター承認あり）、Phase 8 の Firebase プロジェクト作成。

---

## Phase 0: 開発基盤

**目的**: x_Autopost の骨格を移植した、ビルド・push・テスト可能な空の GAS プロジェクトを作る。

**完了条件**: `npm run build` が通り、clasp push で GAS エディタにコードが反映される。X 固有コードが残っていない。

### 開発作業

1. x_Autopost から流用: `esbuild.config.js`、`tsconfig.json`、`appsscript.json`、`utils.ts`（ログ・Errors シート）、`types.d.ts` の共通部、`main.ts` のルーター骨格（`doGet`/`doPost` の target/action 分岐）
2. X 固有モジュール（`auth.ts` の OAuth 1.0a、`api/xauth.ts`、`media.ts` の X アップロード）を除外
3. 新スキーマの型定義: `Platform ('threads' | 'bluesky')`、`PlatformAccount`、`Post`（1行=1配信、`crossPostGroupId`・`inReplyTo`・`mediaUrls` 列を最初から定義）
4. Posts / Posted / Errors シートの初期化関数

### あなたの作業

1. https://script.google.com/ で新規 GAS プロジェクトを作成（例:「Autopost_TB」）し、**スクリプト ID** を私に共有
2. GAS プロジェクトに紐づく Google スプレッドシートを新規作成（コンテナバインドの場合は同時にできる）
3. `clasp login` を実行して clasp を認証（`! clasp login` でこのセッションから実行可能）

---

## Phase 1: Proxy 契約・セキュリティ基盤

**目的**: snake-sns / x_Autopost と同一の Proxy 契約（HMAC 署名検証・setup code 初期化）を動かす。

**完了条件**: 署名付きテストリクエストが通り、無署名リクエストが拒否される。`security.initialize` / `status` が期待どおり動く。

### 開発作業

1. x_Autopost の `security.ts` を移植: `assertProxyAuthorized`、`stableStringify`、HMAC-SHA256 検証、`security.initialize`（唯一の無認証 POST）、`security.status`（無認証 GET）
2. スプレッドシートメニュー（`onOpen` → セットアップコード生成ダイアログ）を移植
3. ローカルから署名付きリクエストを撃つテストスクリプトを作成（フロントが無い間の開発・検証手段）

### あなたの作業

1. GAS を **Web アプリとして初回デプロイ**（「次のユーザーとして実行: 自分」/「アクセスできるユーザー: 全員」）し、承認ダイアログを許可
2. 発行された Web アプリ URL（`.../exec`）を私に共有
3. **以後の運用ルールの確認**: コード更新時は「新しいデプロイ」ではなく「デプロイを管理 → 既存デプロイの編集 → 新バージョン」で URL を固定すること（ADR 0003 の帰結。URL が変わると Phase 3 で登録する Meta のリダイレクト URI が壊れる）

---

## Phase 2: Bluesky 縦貫通（テキスト投稿）

**目的**: 簡単な方のプラットフォームで「アカウント登録 → 予約投稿 → トリガー実行 → Posted 記録」の全経路を先に貫通させる。

**完了条件**: テストスクリプト経由で登録した Bluesky アカウントに、Posts シートの予約行が時刻どおり投稿され、AT URI が Posted に記録される。accessJwt 失効時に自動回復する。

### 開発作業

1. `api/blueskyAuth.ts`: アカウント CRUD（`accountId` ごとにハンドル+アプリパスワード+JWT ペアを PropertiesService に保存）
2. セッション管理: 投稿時オンデマンド回復（accessJwt 失効 → `refreshSession` → それも失効 → `createSession` 再ログイン）。定期リフレッシュトリガーは作らない
3. `com.atproto.repo.createRecord` によるテキスト投稿
4. 投稿トリガーの main ループ移植: Posts シート走査 → 時刻到来行を投稿 → Posted へ移動 → 失敗は Errors 記録。トリガー管理 API（`trigger.create/delete`）も移植

### あなたの作業

1. Bluesky（https://bsky.app/）の「設定 → プライバシーとセキュリティ → アプリパスワード」で**アプリパスワードを発行**し、ハンドル名とともに私に共有（テスト用アカウント推奨。画面を閉じると再表示不可）
2. テスト投稿が実際にタイムラインに表示されることを確認

---

## Phase 3: Threads 認証（OAuth）

**目的**: BYO Meta アプリ + GAS 無認証コールバック方式（ADR 0003）で Threads の長期トークンを取得・保存・自動延命する。

**完了条件**: 認可 URL → Meta の許可画面 → GAS コールバック → 長期トークン保存まで自動完了し、日次メンテナンストリガーがトークンをリフレッシュする。

### 開発作業

1. `api/threadsAuth.ts`: アカウント CRUD（`accountId` ごとに App ID / App Secret / トークン / user_id / 取得日時を保存）
2. 認可 URL 生成 API: `state` パラメータに accountId + CSRF ノンス（CacheService で有効期限管理）を埋め込む。スコープは最初から `threads_basic,threads_content_publish,threads_manage_insights`（ADR 0003 の帰結）
3. `doGet` に**無認証コールバックルート**を新設（`security.status` に次ぐ例外）: `state` 検証 → 認可コード → 短期トークン → 長期トークン交換 → 保存 → 結果 HTML 表示
4. 日次メンテナンストリガー: 全 Threads アカウントを走査し、発行から一定日数（既定 30 日）経過したトークンのみ `th_refresh_token` でリフレッシュ。失敗は Errors 記録

### あなたの作業（このPhaseが手作業の山場）

1. ⏳ https://developers.facebook.com/ で開発者登録（未登録の場合）
2. 「アプリを作成」→ ユースケースで **「Threads の使用事例」** を選択してアプリ作成
3. アプリ設定 → 基本設定から **Threads App ID / Threads App Secret** を取得し私に共有（通常用と Threads 用の 2 種類あるうち **Threads 用** の方）
4. ⏳ アプリの役割 → 「**Threads テスター**」として自分の Threads アカウントを招待し、Threads 側（アカウント設定 → ウェブサイトの権限）で**招待を承認**
5. Meta アプリの「有効な OAuth リダイレクト URI」に **Phase 1 の GAS Web アプリ URL を 1 文字も違わず登録**
6. 私が生成した認可 URL をブラウザで開き、Threads アカウントでログイン・許可（「✅ 認証に成功しました」画面が出るまで）

---

## Phase 4: Threads 投稿(テキスト)

**目的**: Threads への投稿パイプラインを Bluesky と同じ main ループに統合する。

**完了条件**: Posts シートの Threads 宛予約行が時刻どおり投稿され、Media ID が Posted に記録される。クロスポスト（Threads + Bluesky の 2 行一括作成）が両方成功する。

### 開発作業

1. コンテナ作成（`media_type: TEXT`）→ ステータス確認（`FINISHED` 待ち、固定 sleep ではなくポーリング）→ `threads_publish` 公開の 2 ステップ実装
2. `threads_publishing_limit` による残枠チェック（上限近接時は投稿を見送り、次回トリガーへ持ち越し）
3. main ループへの統合: Post の `platform` 列で Bluesky / Threads をディスパッチ
4. `createMultiple` でのクロスポスト一括作成の検証（`crossPostGroupId` 付与）

### あなたの作業

1. テスト投稿が Threads アプリ上で表示されることを確認
2. クロスポスト検証時、片方をわざと失敗させた場合（例: Bluesky 側に 301 グラフェム以上の本文）に**もう片方だけ成功し、失敗行が Errors に残る**ことを確認

---

## Phase 5: 画像対応

**目的**: v1 スコープの画像投稿（Threads: 公開 URL 方式 / Bluesky: `uploadBlob` バイト転送方式）を実装する。

**完了条件**: `mediaUrls` に画像 URL を持つ予約行が、両プラットフォームで画像付き投稿として公開される。

### 開発作業

1. Threads: `media_type: IMAGE` + `image_url`（コンテナステータス確認は Phase 4 実装を流用）
2. Bluesky: GAS が `mediaUrls` の URL をフェッチ → MIME / サイズ検証（約 1MB 上限）→ `uploadBlob` → `embed.images` 付き `createRecord`
3. サイズ超過・非対応 MIME・フェッチ失敗時のエラーを Errors シートに明確に記録（フロント実装時のバリデーション仕様の根拠になる）

### あなたの作業

1. テスト用の公開画像 URL を 1〜2 個用意（この時点では Firebase Storage 未構築のため、外部からアクセスできる URL なら何でもよい）
2. 両プラットフォームで画像付き投稿の表示を確認

---

## Phase 6: スレッド連投

**目的**: 同一 PlatformAccount 宛の `inReplyTo` 連鎖（CONTEXT.md「Thread」）を実装する。

**完了条件**: 3 件連鎖のスレッドが両プラットフォームで正しい親子関係・順序で投稿される。途中失敗時に後続が誤投稿されず、再開できる。

### 開発作業

1. x_Autopost の `updateInReplyTo` / スレッド投稿順序保証ロジックを移植
2. Threads: `reply_to_id` によるリプライ投稿。Bluesky: `reply` の root/parent 参照（CID 取得含む）
3. 途中失敗時の挙動: 親が未投稿なら子はスキップして次回トリガーで再開。連鎖はプラットフォームごとに独立(クロスポストされたスレッドは 2 本の別連鎖)

### あなたの作業

1. 3 件スレッドのテストで、両プラットフォームの表示上「1 本のスレッド」に見えることを確認
2. 2 件目をわざと失敗させ、3 件目が投稿されずに残り、修正後の次回トリガーで連鎖が再開することを確認

---

## Phase 7: エンゲージメント蓄積

**目的**: 投稿単位のエンゲージメントを日次トリガーで Posted シートに蓄積する（Q8/Q9 合意: 投稿単位のみ蓄積、アカウント全体はオンデマンド GET）。

**完了条件**: 日次トリガーが Posted の各行に最新数値を書き込む。アカウント現在値が GET エンドポイントで取得できる。

### 開発作業

1. Threads: `{media-id}/insights`（views/likes/replies/reposts/quotes/shares）
2. Bluesky: 公開 API（`getPostThread` 等）から likes/reposts/replies/quotes を取得
3. 日次トリガー: Posted シート走査 → エンゲージメント列 + 更新日時を更新。レート制限対策のウェイト、失敗行はスキップして続行
4. アカウント現在値のオンデマンド GET エンドポイント（Threads: `threads_insights` / Bluesky: `getProfile` のフォロワー数等）
5. アーカイブ機構（`api/archive.ts`）の移植と、エンゲージメント列を含めた動作確認

### あなたの作業

1. 投稿から一晩置いた後、Posted シートに数値が入っていることを確認（投稿直後は集計反映が遅れるため）

---

## Phase 8: フロントエンド基盤（snake-sns フォーク）

**目的**: snake-sns をフォークした別アプリを新 Firebase プロジェクトで立ち上げ、Proxy 経由で GAS に到達させる（ADR 0001）。

**完了条件**: フォークしたフロントにログインし、GAS URL + セットアップコードで接続初期化（`initializeGasProxyAuth`）が成功し、署名付きリクエストが GAS に通る。

### 開発作業

1. snake-sns を新リポジトリにフォークし、X 固有機能を削除（アカウント管理 UI・投稿 UI は Phase 9 で差し替えるため一旦スタブ化）
2. Firebase 設定の差し替え（`.env.*`、`.firebaserc`）、プロジェクト名・ブランディングの変更
3. `functions/src/handlers/proxy.ts` ほか Proxy 契約まわりは**無改変で流用**。RTDB/Firestore のスキーマ（`googleSheetUrl`、`gasProxySecrets`）もそのまま
4. Functions / Hosting のデプロイ設定と動作確認

### あなたの作業

1. Firebase コンソールで**新プロジェクトを作成**（dev 用。本番を分けるなら prod 用も）
2. Blaze プラン（従量課金）へのアップグレード（Functions の外部 HTTP 呼び出しに必須）
3. Firebase Authentication の有効化（snake-sns と同じサインイン方法）、Realtime Database / Firestore / Storage の有効化
4. `firebase login` 状態の確認と、新プロジェクトのウェブアプリ構成値（apiKey 等）を `.env` 用に共有
5. デプロイ後、スプレッドシートのメニューからセットアップコードを生成し、フロントの接続画面で GAS URL とともに入力して初期化が成功することを確認

---

## Phase 9: フロント UI（アカウント管理・投稿・画像）

**目的**: X 用 UI を Threads/Bluesky 用に差し替え、v1 の全機能を UI から操作可能にする。

**完了条件**: UI だけで「アカウント登録 → 予約投稿作成（単発/クロスポスト/スレッド・画像付き）→ 結果とエンゲージメント確認」が完結する。

### 開発作業

1. アカウント管理画面: Bluesky（ハンドル+アプリパスワード入力）/ Threads（App ID/Secret 入力 → 認可 URL 表示 → 認可完了の反映）
2. 投稿作成画面: プラットフォーム別文字数バリデーション（Threads 500 字 / Bluesky 300 **グラフェム**）、クロスポスト時のアカウント複数選択（`createMultiple` で複数 Post 一括作成、プラットフォーム別本文の上書き入力）、スレッド作成 UI
3. 画像: Firebase Storage へのアップロード + **クライアント側リサイズ/圧縮**（Bluesky 約 1MB 上限対応）、`mediaUrls` にダウンロード URL を格納
4. 投稿一覧: ステータス・エラー・投稿 ID・エンゲージメント数値の表示

### あなたの作業

1. UI を触っての受け入れ確認（特に: 301 グラフェム以上入力時に Bluesky 選択がエラー表示になるか、クロスポストの本文上書きが機能するか）
2. デザイン・文言の好みのフィードバック

---

## Phase 10: E2E 検証・運用整備

**目的**: 本番相当の通し検証と、運用ルールの文書化。

**完了条件**: 本番アカウントで全機能が通り、運用手順（README / ユーザーマニュアル）が揃う。

### 開発作業

1. E2E チェックリスト作成と通し検証（アカウント登録 → 各種投稿 → 失敗系 → トークン延命 → エンゲージメント → アーカイブ）
2. トークン失効・認可切れ時のユーザー向けエラーメッセージ整備（Threads 再認可への導線）
3. README / セットアップマニュアル執筆（x_Autopost の USER_MANUAL_JP.md 相当。あなたが Phase 0〜8 で行った手作業がそのまま他ユーザーのセットアップ手順になる）
4. `draft/` の旧ドラフト 3 枚に「アーカイブ済み・現行設計は CONTEXT.md / docs/adr 参照」の注記を付ける

### あなたの作業

1. 本番用アカウント（Threads / Bluesky）での最終確認
2. Threads トークンを意図的に無効化した場合の再認可フローの確認
3. リリース判断
