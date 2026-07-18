# Google Apps Script（GAS）で Threads 自動投稿を行うための手順書

対象：Meta Threads API を使い、GAS から投稿を自動化したい方
構成：①Threads API登録手順　②GASコード実装手順（コールバック自動受信版）

---

## 0. 全体の流れ（サマリー）

1. Meta for Developers でアプリを作成し「Threads の使用事例」を追加
2. Threads App ID / App Secret を取得
3. 自分の Threads アカウントを「Threads テスター」として登録・承認
4. **GAS プロジェクトを作成し、認可コードを自動受信する Web アプリ（`doGet`）をデプロイ**
5. そのデプロイURLを Meta アプリの「リダイレクトURI」として登録
6. 認可URLにアクセスして許可すると、GASが自動的に
   - 認可コード受信 → 短期トークン交換 → 長期トークン交換 → スクリプトプロパティ保存
   まで一気に行う
7. GAS から投稿API（コンテナ作成→公開の2ステップ）を呼び出す関数を実装
8. トリガーを設定して自動投稿・トークン自動更新を行う

> 従来はブラウザのURLからコードを手でコピーしていましたが、今回の手順では **GASのWebアプリが自動でコードを受け取り、トークン交換・保存まで自動で完結** します。

---

## 1. Threads API 登録手順（前半：アプリ作成まで）

### 1-1. Meta for Developers アカウントの準備

1. https://developers.facebook.com/ にアクセスし、普段使っている Facebook アカウントでログイン
2. 開発者登録がまだの場合は画面の案内に従って開発者登録を完了

### 1-2. アプリを作成する

1. 「マイアプリ」→「アプリを作成」
2. ユースケースの選択画面で **「Threads の使用事例（Threads Use Case）」** を選択
3. アプリ名などを入力してアプリを作成

> ポイント：作成したアプリには「アプリID/アプリシークレット」が **通常用** と **Threads用** の2種類表示されます。Threads API を叩く際は必ず **Threads App ID / Threads App Secret** の方を使います。

### 1-3. Threads App ID / App Secret を確認

1. 作成したアプリのダッシュボードで「アプリ設定」→「基本設定」を開く
2. **Threads App ID** と **Threads App secret** をメモ（この後 GAS に保存します）

### 1-4. 自分自身を「Threads テスター」として追加

1. アプリダッシュボード → 「アプリの役割」→「役割」タブ
2. 「ユーザーを追加」→「Threadsテスター」を選択し、自分のThreadsアカウントを招待
3. 招待を受けるには、Threads アプリ（またはWeb版 https://www.threads.net/settings/account ）の「アカウント設定」→「ウェブサイトの権限」から招待を承認

> アプリを一般公開（App Review通過）していない間は、この「テスター登録」をしたアカウントでしか投稿できません。個人利用であればテスター登録だけで十分です。

**この時点ではリダイレクトURIはまだ設定しません。** 次の章でGAS側のURLを先に作ってから登録します。

---

## 2. GASプロジェクトの準備とコールバック自動受信の実装

### 2-1. 新規 GAS プロジェクトを作成

1. https://script.google.com/ → 「新しいプロジェクト」
2. プロジェクト名を「Threads自動投稿」などに変更

### 2-2. App ID / App Secret をスクリプトプロパティに保存

`ファイル`→`プロジェクトのプロパティ`→`スクリプトのプロパティ` で以下を登録するか、下記関数を一度だけ実行します（実行後はコード内の値を削除してください）。

```javascript
function setup_setProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    THREADS_APP_ID: '取得したApp ID',
    THREADS_APP_SECRET: '取得したApp Secret'
  });
}
```

### 2-3. コールバック自動受信用の `doGet` を実装

Metaからのリダイレクトを受け取り、そのまま **短期トークン→長期トークンへの交換・保存まで自動実行** する関数です。

```javascript
/**
 * Threadsの認可リダイレクトを受け取るWebアプリのエントリーポイント
 * URL例: https://script.google.com/macros/s/xxxx/exec?code=AQBx-hBsH3...
 */
function doGet(e) {
  const code = e.parameter.code;
  const error = e.parameter.error;

  if (error) {
    return HtmlService.createHtmlOutput(
      '<h3>認可がキャンセルされました</h3><p>' + e.parameter.error_description + '</p>'
    );
  }
  if (!code) {
    return HtmlService.createHtmlOutput('<h3>認可コードが見つかりませんでした。</h3>');
  }

  try {
    const props = PropertiesService.getScriptProperties();
    const appId = props.getProperty('THREADS_APP_ID');
    const appSecret = props.getProperty('THREADS_APP_SECRET');
    const redirectUri = props.getProperty('THREADS_REDIRECT_URI');

    // ① 認可コード → 短期アクセストークン
    const shortRes = UrlFetchApp.fetch('https://graph.threads.net/oauth/access_token', {
      method: 'post',
      payload: {
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code: code
      },
      muteHttpExceptions: true
    });
    const shortData = JSON.parse(shortRes.getContentText());
    if (!shortData.access_token) {
      return HtmlService.createHtmlOutput(
        '<h3>短期トークン取得に失敗しました</h3><pre>' + JSON.stringify(shortData) + '</pre>'
      );
    }

    // ② 短期アクセストークン → 長期アクセストークン（60日）
    const longUrl = 'https://graph.threads.net/access_token'
      + '?grant_type=th_exchange_token'
      + '&client_secret=' + encodeURIComponent(appSecret)
      + '&access_token=' + encodeURIComponent(shortData.access_token);
    const longRes = UrlFetchApp.fetch(longUrl, { muteHttpExceptions: true });
    const longData = JSON.parse(longRes.getContentText());
    if (!longData.access_token) {
      return HtmlService.createHtmlOutput(
        '<h3>長期トークン取得に失敗しました</h3><pre>' + JSON.stringify(longData) + '</pre>'
      );
    }

    // ③ 保存
    props.setProperty('THREADS_USER_ID', String(shortData.user_id));
    props.setProperty('THREADS_ACCESS_TOKEN', longData.access_token);
    props.setProperty('THREADS_TOKEN_SAVED_AT', new Date().toISOString());

    return HtmlService.createHtmlOutput(
      '<h3>✅ 認証に成功しました</h3><p>アクセストークンを保存しました。このタブは閉じて構いません。</p>'
    );
  } catch (err) {
    return HtmlService.createHtmlOutput('<h3>エラーが発生しました</h3><pre>' + err.message + '</pre>');
  }
}
```

### 2-4. Webアプリとしてデプロイし、コールバックURLを取得

1. GASエディタ右上の「デプロイ」→「新しいデプロイ」
2. 種類の選択で歯車アイコン →「ウェブアプリ」を選択
3. 設定：
   - 「次のユーザーとして実行」：**自分**
   - 「アクセスできるユーザー」：**全員**（Metaのサーバーからも未ログイン状態でアクセスされるため）
4. 「デプロイ」をクリックし、認可を求められたら許可
5. 表示された **ウェブアプリのURL**（`https://script.google.com/macros/s/xxxxxxxx/exec` の形式）をコピー

> 注意：コードを修正した後にURLを固定したまま更新したい場合は、「新しいデプロイ」ではなく「デプロイを管理」→ 既存デプロイの「編集」→ バージョンを「新バージョン」にして更新してください。「新しいデプロイ」を選ぶとURLが変わってしまいます。

### 2-5. コールバックURLをスクリプトプロパティとMetaアプリ両方に登録

1. GASのスクリプトプロパティに追加：

```javascript
function setup_setRedirectUri() {
  PropertiesService.getScriptProperties().setProperty(
    'THREADS_REDIRECT_URI',
    'https://script.google.com/macros/s/xxxxxxxx/exec' // 2-4でコピーしたURL
  );
}
```

2. Meta for Developers のアプリダッシュボード →「Threadsの使用事例」の設定 →「有効なOAuthリダイレクトURI」に **同じURLを1文字も違わず** 登録して保存

---

## 3. 認可の実行（ここから先はブラウザで1回開くだけ）

以下のURLの `<...>` 部分を自分の値に置き換え、ブラウザで開いてThreadsアカウントでログイン・許可します。

```
https://threads.net/oauth/authorize
  ?client_id=<THREADS_APP_ID>
  &redirect_uri=<2-4でコピーしたウェブアプリURL>
  &scope=threads_basic,threads_content_publish,threads_manage_insights
  &response_type=code
```

> `threads_manage_insights` は投稿・アカウントのエンゲージメント情報（インサイト）を取得するために必要な権限です（詳細は章5参照）。すでに他のscopeだけで認可済みの場合は、このURLで再度許可し直せばトークンが `threads_manage_insights` 込みで再発行されます。

許可すると自動的に GAS の `doGet` にリダイレクトされ、

- 短期トークン取得
- 長期トークン交換
- スクリプトプロパティへの保存（`THREADS_USER_ID` / `THREADS_ACCESS_TOKEN`）

まで **すべて自動で完了** し、「✅ 認証に成功しました」という画面が表示されます。

> 認可コードは1回しか使えないため、この画面でエラーが出た場合はURLを再度開き直してやり直してください。

---

## 4. 投稿処理の実装

### 4-1. テキスト投稿（コンテナ作成 → 公開の2ステップ）

```javascript
/**
 * Threadsにテキスト投稿する
 * @param {string} text 投稿本文
 */
function postToThreads(text) {
  const props = PropertiesService.getScriptProperties();
  const userId = props.getProperty('THREADS_USER_ID');
  const accessToken = props.getProperty('THREADS_ACCESS_TOKEN');

  // ① メディアコンテナ作成
  const createUrl = `https://graph.threads.net/v1.0/${userId}/threads`;
  const createRes = UrlFetchApp.fetch(createUrl, {
    method: 'post',
    payload: {
      media_type: 'TEXT',
      text: text,
      access_token: accessToken
    },
    muteHttpExceptions: true
  });
  const createData = JSON.parse(createRes.getContentText());
  if (!createData.id) {
    throw new Error('コンテナ作成に失敗: ' + JSON.stringify(createData));
  }
  const creationId = createData.id;

  // 生成直後は処理中のことがあるため少し待つ
  Utilities.sleep(3000);

  // ② コンテナを公開
  const publishUrl = `https://graph.threads.net/v1.0/${userId}/threads_publish`;
  const publishRes = UrlFetchApp.fetch(publishUrl, {
    method: 'post',
    payload: {
      creation_id: creationId,
      access_token: accessToken
    },
    muteHttpExceptions: true
  });
  const publishData = JSON.parse(publishRes.getContentText());
  if (!publishData.id) {
    throw new Error('公開に失敗: ' + JSON.stringify(publishData));
  }

  Logger.log('投稿完了。Threads Media ID: ' + publishData.id);
  return publishData.id;
}

/**
 * テスト実行用
 */
function testPost() {
  postToThreads('GASからのテスト投稿です。');
}
```

### 4-2. 長期アクセストークンの自動リフレッシュ

長期トークンは60日で失効するため、定期的に更新する関数を用意します（発行から24時間経過後、失効前であれば更新可能）。

```javascript
/**
 * 長期アクセストークンをリフレッシュして保存し直す
 */
function refreshThreadsToken() {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty('THREADS_ACCESS_TOKEN');

  const url = `https://graph.threads.net/refresh_access_token`
    + `?grant_type=th_refresh_token`
    + `&access_token=${accessToken}`;

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());

  if (!data.access_token) {
    throw new Error('トークン更新に失敗: ' + JSON.stringify(data));
  }

  props.setProperty('THREADS_ACCESS_TOKEN', data.access_token);
  Logger.log('トークンを更新しました。有効期限まで残り約' + Math.floor(data.expires_in / 86400) + '日');
}
```

### 4-3. トリガーを設定する

GASエディタ左メニューの「トリガー」から以下を設定します。

| 関数 | 頻度の目安 | 目的 |
|---|---|---|
| `postToThreads` を呼ぶラッパー関数 | 投稿したいタイミング（例：毎日9時） | 自動投稿 |
| `refreshThreadsToken` | 7〜14日ごと | トークン失効防止（60日以内に必ず1回） |

例：スプレッドシートの内容を定期投稿したい場合のラッパー関数

```javascript
function scheduledPost() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予約');
  const data = sheet.getDataRange().getValues(); // 例: [投稿本文, 投稿済みフラグ, MediaID]

  for (let i = 1; i < data.length; i++) {
    const [text, done] = data[i];
    if (text && !done) {
      const mediaId = postToThreads(text);
      sheet.getRange(i + 1, 2).setValue(true);     // B列：投稿済みにする
      sheet.getRange(i + 1, 3).setValue(mediaId);   // C列：Media IDを記録（インサイト取得に使用）
      break; // 1回のトリガーで1件だけ投稿する場合
    }
  }
}
```

> C列に記録した Media ID は、次章「5. エンゲージメント情報の取得」で投稿ごとのインサイトを取得する際に使います。

### 4-4. 動作確認

1. `testPost` を手動実行し、実行ログでエラーが出ないか確認
2. 自分の Threads アプリを開き、実際に投稿されているか確認
3. 問題なければ `scheduledPost` 用のトリガーと `refreshThreadsToken` 用のトリガーを有効化

---

## 5. エンゲージメント情報（インサイト）の取得

Threads APIでは「投稿ごと」「アカウント全体」の2種類のインサイト（views・likes・replies・reposts・quotes・shares等）を取得できます。取得には章3で追加した `threads_manage_insights` 権限でのトークンが必要です。

### 5-1. 投稿単位のインサイトを取得する

```javascript
/**
 * 指定した投稿（Media ID）のエンゲージメント情報を取得する
 * @param {string} mediaId postToThreadsの戻り値（投稿のMedia ID）
 * @return {Object} {views, likes, replies, reposts, quotes, shares}
 */
function getPostInsights(mediaId) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty('THREADS_ACCESS_TOKEN');
  const metrics = 'views,likes,replies,reposts,quotes,shares';

  const url = `https://graph.threads.net/v1.0/${mediaId}/insights?metric=${metrics}&access_token=${accessToken}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());

  if (!data.data) {
    throw new Error('インサイト取得に失敗: ' + JSON.stringify(data));
  }

  const insights = {};
  data.data.forEach(item => {
    insights[item.name] = item.values && item.values[0] ? item.values[0].value : 0;
  });
  return insights; // 例: { views: 120, likes: 8, replies: 2, reposts: 0, quotes: 0, shares: 1 }
}
```

### 5-2. アカウント全体のインサイトを取得する

```javascript
/**
 * アカウント全体のインサイトを取得する
 * @param {Date} [sinceDate] 集計開始日（省略時は前日〜当日の2日間）
 * @param {Date} [untilDate] 集計終了日
 * @return {Object} {views, likes, replies, reposts, quotes, clicks, followers_count}
 */
function getAccountInsights(sinceDate, untilDate) {
  const props = PropertiesService.getScriptProperties();
  const userId = props.getProperty('THREADS_USER_ID');
  const accessToken = props.getProperty('THREADS_ACCESS_TOKEN');
  const metrics = 'views,likes,replies,reposts,quotes,clicks,followers_count';

  let url = `https://graph.threads.net/v1.0/${userId}/threads_insights?metric=${metrics}&access_token=${accessToken}`;
  if (sinceDate && untilDate) {
    url += `&since=${Math.floor(sinceDate.getTime() / 1000)}&until=${Math.floor(untilDate.getTime() / 1000)}`;
  }

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());

  if (!data.data) {
    throw new Error('アカウントインサイト取得に失敗: ' + JSON.stringify(data));
  }

  const insights = {};
  data.data.forEach(item => {
    insights[item.name] = item.values && item.values[0] ? item.values[0].value : 0;
  });
  return insights;
}
```

> `follower_demographics`（フォロワー属性）を取得したい場合はmetricに追加できますが、`since`/`until`と併用できない点に注意してください。

### 5-3. 投稿予約シートのエンゲージメントを自動更新する

章4-3の「投稿予約」シートのC列に記録したMedia IDを使い、各投稿の最新エンゲージメントをD列以降に書き込みます。

```javascript
/**
 * 投稿予約シートの投稿済み行について、エンゲージメント情報を更新する
 * シート列構成: A=投稿本文, B=投稿済みフラグ, C=MediaID,
 *               D=views, E=likes, F=replies, G=reposts, H=quotes, I=shares, J=更新日時
 */
function updateAllPostInsights() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('投稿予約');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const mediaId = data[i][2]; // C列
    if (!mediaId) continue;

    try {
      const insights = getPostInsights(mediaId);
      sheet.getRange(i + 1, 4, 1, 6).setValues([[
        insights.views || 0,
        insights.likes || 0,
        insights.replies || 0,
        insights.reposts || 0,
        insights.quotes || 0,
        insights.shares || 0
      ]]);
      sheet.getRange(i + 1, 10).setValue(new Date()); // J列：更新日時
    } catch (e) {
      Logger.log(`Media ID ${mediaId} のインサイト取得に失敗: ${e.message}`);
    }

    Utilities.sleep(500); // APIのレート制限対策
  }
}
```

### 5-4. トリガーを追加する

| 関数 | 頻度の目安 | 目的 |
|---|---|---|
| `updateAllPostInsights` | 1日1回程度（例：毎日23時） | 過去の投稿のエンゲージメントを最新化 |

> 投稿直後はviews等が安定していないことがあるため、投稿当日〜数日は数値が変動する前提で見てください。

---

## 6. 料金・レート制限について

### 6-1. 料金

Threads APIは無料で利用できます。Meta公式ドキュメントに有料プランや従量課金の記載はなく、投稿・インサイト取得ともに費用はかかりません。

### 6-2. レート制限（呼び出し回数の上限）

無料である一方、以下のような上限があります。個人でGASから1日数回投稿する程度であれば通常問題になりませんが、頭に入れておくと安心です。

| 項目 | 上限の目安 |
|---|---|
| 24時間あたりの新規投稿数 | 250件／プロフィール |
| 24時間あたりのリプライ数 | 1,000件／プロフィール |
| 24時間あたりの削除数 | 100件／プロフィール |
| API呼び出し全体 | 4,800 ×（過去24時間のインプレッション数）。インプレッション数は最低10とみなされるため、1日あたり最低でも約48,000回分の呼び出し枠がある |

> フォロワーが少ない・投稿頻度が低いアカウントほどインプレッション数が少なくなるため、API呼び出し全体の枠も相対的に小さくなります。極端に高頻度でAPIを叩く運用（例：数秒おきのポーリング）は避け、トリガーの間隔は数分〜数十分単位に留めるのが無難です。

### 6-3. 現在の使用状況を確認する

投稿の残り回数は `threads_publishing_limit` エンドポイントで確認できます。

```javascript
/**
 * 現在の投稿レート制限の使用状況を取得する
 */
function getPublishingLimit() {
  const props = PropertiesService.getScriptProperties();
  const userId = props.getProperty('THREADS_USER_ID');
  const accessToken = props.getProperty('THREADS_ACCESS_TOKEN');

  const url = `https://graph.threads.net/v1.0/${userId}/threads_publishing_limit`
    + `?fields=quota_usage,config`
    + `&access_token=${accessToken}`;

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());

  if (!data.data) {
    throw new Error('レート制限情報の取得に失敗: ' + JSON.stringify(data));
  }

  Logger.log(JSON.stringify(data.data[0], null, 2));
  return data.data[0]; // 例: { quota_usage: 3, config: { quota_total: 250, quota_duration: 86400 } }
}
```

- `quota_usage`：直近24時間ですでに使用した投稿数
- `config.quota_total`：24時間あたりの上限（通常250）
- `config.quota_duration`：集計期間（秒。86400 = 24時間）

大量投稿や複数アカウント管理を行う場合は、`scheduledPost` の実行前にこの関数で残り枠を確認し、上限に近い場合は投稿を見送るようにすると安全です。

---

## 7. 注意点・トラブルシューティング

- **`redirect_uri did not match`（または同様のエラー）**：認可URLの `redirect_uri` パラメータ、`THREADS_REDIRECT_URI` スクリプトプロパティ、Metaアプリ側の「有効なOAuthリダイレクトURI」の3箇所が **完全に一致している** か確認してください（末尾のスラッシュの有無にも注意）。
- **`Matching code was not found or was already used`**：認可コードは1回しか使えません。手順3の認可URLを開き直してください。
- **doGetが動かない/権限エラーになる**：デプロイ設定の「アクセスできるユーザー」が「全員」になっているか確認してください。「自分のみ」だとMetaのサーバーからアクセスできません。
- **投稿が反映されない**：メディアコンテナ作成直後は処理中の場合があるため、`GET /{container-id}?fields=status` でステータス（`FINISHED`等）を確認してから公開するとより安定します。
- **画像・動画を投稿したい場合**：`media_type` を `IMAGE` / `VIDEO` にし、`image_url` / `video_url` に公開URLを指定します（Google Driveの直リンクなど、外部からアクセスできるURLである必要があります）。
- **本番公開（テスター以外も投稿対象にしたい場合）**：`threads_content_publish` などの権限についてMetaの App Review を通す必要があります。個人利用のみなら不要です。
- **インサイト取得で `(#100) Invalid parameter` や権限エラーになる**：認可URLの `scope` に `threads_manage_insights` を含めて再認可したか、また投稿してから数分〜数十分経っていて指標が集計済みかを確認してください（投稿直後は反映が遅れることがあります）。
- **`429 Too Many Requests` やレート制限エラーになる**：章6のレート制限（24時間あたり250投稿等）に達している可能性があります。`getPublishingLimit()` で残り枠を確認し、トリガーの実行間隔を空ける・1回の実行で投稿する件数を減らすなどの対応を行ってください。
- **セキュリティ**：`doGet` は「全員」アクセス可能な設定にしますが、処理するのは1回しか使えない短命の認可コードのみです。念のため、認証完了後は `THREADS_APP_SECRET` 等が画面やログに表示されないことを確認してください。
- **APIの仕様変更**：Threads APIは更新が続いているため、実装前に公式ドキュメント（https://developers.facebook.com/docs/threads ）の changelog も確認することをおすすめします。

---

以上で、Threads APIの登録から、GASによるコールバック自動受信・自動投稿の実装までが完了です。
