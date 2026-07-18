# Google Apps Script（GAS）で Bluesky 自動投稿・エンゲージメント取得を行うための手順書

対象：Bluesky（AT Protocol）を使い、GASから投稿の自動化とエンゲージメント取得を行いたい方

---

## 0. 結論と全体像

**Bluesky APIでも「投稿」「エンゲージメント情報の取得」の両方が可能です。**
ただし、Threads APIとは仕組みが異なる点があるので、最初に整理しておきます。

| 項目 | Threads API | Bluesky API |
|---|---|---|
| 使っているプロトコル | Meta Graph API（REST） | AT Protocol（独自プロトコル、エンドポイントは `xrpc` 形式） |
| 認証方式 | OAuth（App ID/Secret＋認可コード） | **アプリパスワード**（ハンドル＋専用パスワードでログインするだけ。OAuthより簡単） |
| トークンの形 | 長期アクセストークン（60日） | `accessJwt`（数時間で失効）＋ `refreshJwt`（約2ヶ月） |
| 料金 | 無料 | 無料 |
| エンゲージメント取得 | 別途 `threads_manage_insights` 権限が必要 | 公開API（認証不要）で誰でも取得可能 |

> いわゆる「APIキー」を1つ発行して終わり、という形ではなく、Blueskyでは「アプリパスワード」でログインして得られる一時的なトークン（JWT）を使う方式です。Threadsより設定はシンプルです。

全体の流れ：

1. Blueskyの設定画面で「アプリパスワード」を発行
2. GASのスクリプトプロパティに、ハンドル名とアプリパスワードを保存
3. GASから `createSession`（ログイン）してJWTトークンを取得・保存
4. トークンを使って投稿（`createRecord`）
5. トークン切れに備えて `refreshSession`（リフレッシュ）を実装
6. 投稿ごと・アカウント全体のエンゲージメント（いいね・リポスト・返信・引用）を公開APIから取得
7. トリガーを設定して自動投稿・エンゲージメント更新を行う

---

## 1. Blueskyアプリパスワードの発行

1. https://bsky.app/ にログイン
2. 「設定（Settings）」→「プライバシーとセキュリティ（Privacy and Security）」→「アプリパスワード（App Passwords）」を開く
3. 「アプリパスワードを追加（Add App Password）」をクリックし、名前（例：`GAS自動投稿`）を入力
4. 表示された `xxxx-xxxx-xxxx-xxxx` 形式のパスワードをメモ（**この画面を閉じると二度と表示されません**）

> 通常ログイン用のパスワードそのものは絶対に使わないでください。アプリパスワードは万一漏れてもメインアカウントのパスワードを変更する必要がなく、個別に無効化できるため安全です。

---

## 2. GASプロジェクトの準備

### 2-1. 新規 GAS プロジェクトを作成

1. https://script.google.com/ → 「新しいプロジェクト」
2. プロジェクト名を「Bluesky自動投稿」などに変更

### 2-2. スクリプトプロパティに認証情報を保存

```javascript
function setup_setBlueskyProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    BLUESKY_HANDLE: 'yourname.bsky.social',   // 自分のハンドル
    BLUESKY_APP_PASSWORD: 'xxxx-xxxx-xxxx-xxxx' // 1章で発行したアプリパスワード
  });
}
```

実行後は、コード内のパスワードを削除しておいてください。

### 2-3. ログインしてセッション（トークン）を取得する

```javascript
/**
 * Blueskyにログインし、アクセストークン等を取得・保存する
 */
function bluesky_login() {
  const props = PropertiesService.getScriptProperties();
  const handle = props.getProperty('BLUESKY_HANDLE');
  const appPassword = props.getProperty('BLUESKY_APP_PASSWORD');

  const url = 'https://bsky.social/xrpc/com.atproto.server.createSession';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ identifier: handle, password: appPassword }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());

  if (!data.accessJwt) {
    throw new Error('ログインに失敗しました: ' + JSON.stringify(data));
  }

  props.setProperty('BLUESKY_DID', data.did);              // アカウントの一意なID
  props.setProperty('BLUESKY_ACCESS_JWT', data.accessJwt);   // 数時間で失効
  props.setProperty('BLUESKY_REFRESH_JWT', data.refreshJwt); // 約2ヶ月有効

  Logger.log('ログイン成功。DID: ' + data.did);
  return data;
}
```

一度 `bluesky_login` を手動実行しておけば、以降はスクリプトプロパティに保存された `BLUESKY_ACCESS_JWT` / `BLUESKY_REFRESH_JWT` を使い回せます。

### 2-4. トークンをリフレッシュする関数

`accessJwt` は数時間で切れるため、切れた場合に自動で更新する仕組みを用意します。

```javascript
/**
 * refreshJwtを使ってaccessJwtを更新する
 */
function bluesky_refreshSession() {
  const props = PropertiesService.getScriptProperties();
  const refreshJwt = props.getProperty('BLUESKY_REFRESH_JWT');

  const url = 'https://bsky.social/xrpc/com.atproto.server.refreshSession';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + refreshJwt },
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());

  if (!data.accessJwt) {
    // refreshJwt自体も失効している場合はbluesky_loginからやり直す
    throw new Error('セッション更新に失敗しました。再ログインが必要な可能性があります: ' + JSON.stringify(data));
  }

  props.setProperty('BLUESKY_ACCESS_JWT', data.accessJwt);
  props.setProperty('BLUESKY_REFRESH_JWT', data.refreshJwt); // refreshJwtも都度更新される
  Logger.log('セッションを更新しました。');
}
```

---

## 3. 投稿処理の実装

### 3-1. テキスト投稿

Threadsのような「コンテナ作成→公開」の2ステップは不要で、`createRecord` エンドポイントを1回呼ぶだけで投稿できます。

```javascript
/**
 * Blueskyにテキスト投稿する（トークン切れ時は自動でリフレッシュして再試行）
 * @param {string} text 投稿本文（300文字/グラフェムまで）
 * @return {string} 投稿のAT URI（例: at://did:plc:xxxx/app.bsky.feed.post/xxxx）
 */
function postToBluesky(text) {
  const props = PropertiesService.getScriptProperties();
  const did = props.getProperty('BLUESKY_DID');

  const createUrl = 'https://bsky.social/xrpc/com.atproto.repo.createRecord';
  const payload = {
    repo: did,
    collection: 'app.bsky.feed.post',
    record: {
      '$type': 'app.bsky.feed.post',
      text: text,
      createdAt: new Date().toISOString()
    }
  };

  const doRequest = (accessJwt) => UrlFetchApp.fetch(createUrl, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + accessJwt },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  let accessJwt = props.getProperty('BLUESKY_ACCESS_JWT');
  let res = doRequest(accessJwt);

  // トークン切れ（401など）の場合は1回だけリフレッシュして再試行
  if (res.getResponseCode() === 401 || res.getResponseCode() === 400) {
    bluesky_refreshSession();
    accessJwt = props.getProperty('BLUESKY_ACCESS_JWT');
    res = doRequest(accessJwt);
  }

  const data = JSON.parse(res.getContentText());
  if (!data.uri) {
    throw new Error('投稿に失敗しました: ' + JSON.stringify(data));
  }

  Logger.log('投稿完了。URI: ' + data.uri);
  return data.uri;
}

/**
 * テスト実行用
 */
function testBlueskyPost() {
  postToBluesky('GASからのBlueskyテスト投稿です。');
}
```

### 3-2. トリガーを設定する

| 関数 | 頻度の目安 | 目的 |
|---|---|---|
| `postToBluesky` を呼ぶラッパー関数 | 投稿したいタイミング | 自動投稿 |
| `bluesky_refreshSession` | 1週間に1回程度 | `refreshJwt`（約2ヶ月で失効）を延命させる |

例：スプレッドシートと連携した定期投稿（Threads版と同様の構成）

```javascript
function scheduledBlueskyPost() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bluesky投稿予約');
  const data = sheet.getDataRange().getValues(); // A=本文, B=投稿済みフラグ, C=投稿URI

  for (let i = 1; i < data.length; i++) {
    const [text, done] = data[i];
    if (text && !done) {
      const uri = postToBluesky(text);
      sheet.getRange(i + 1, 2).setValue(true); // B列：投稿済みにする
      sheet.getRange(i + 1, 3).setValue(uri);   // C列：投稿URIを記録（後のエンゲージメント取得用）
      break;
    }
  }
}
```

---

## 4. エンゲージメント情報の取得

Blueskyのエンゲージメント（いいね・リポスト・返信・引用の数）は **公開API（認証不要）** で誰でも取得できます。自分の投稿はもちろん、他人の公開投稿の数値も見られます。

### 4-1. 自分の投稿一覧とエンゲージメントをまとめて取得

```javascript
/**
 * 自分の投稿一覧をエンゲージメント付きで取得する
 * @param {number} [limit] 取得件数（最大100、省略時50）
 * @return {Array<Object>} 投稿ごとの {uri, text, createdAt, likes, reposts, replies, quotes}
 */
function getMyBlueskyPosts(limit) {
  const props = PropertiesService.getScriptProperties();
  const handle = props.getProperty('BLUESKY_HANDLE');

  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed`
    + `?actor=${encodeURIComponent(handle)}&limit=${limit || 50}`;

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());

  if (!data.feed) {
    throw new Error('投稿一覧の取得に失敗しました: ' + JSON.stringify(data));
  }

  return data.feed.map(item => ({
    uri: item.post.uri,
    text: item.post.record.text,
    createdAt: item.post.record.createdAt,
    likes: item.post.likeCount || 0,
    reposts: item.post.repostCount || 0,
    replies: item.post.replyCount || 0,
    quotes: item.post.quoteCount || 0
  }));
}
```

### 4-2. 特定の1投稿のエンゲージメントを取得

```javascript
/**
 * 指定した投稿（AT URI）のエンゲージメント情報を取得する
 * @param {string} postUri postToBlueskyの戻り値（例: at://did:plc:xxxx/app.bsky.feed.post/xxxx）
 * @return {Object} {likes, reposts, replies, quotes}
 */
function getBlueskyPostEngagement(postUri) {
  const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread`
    + `?uri=${encodeURIComponent(postUri)}`;

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  const post = data.thread && data.thread.post;

  if (!post) {
    throw new Error('投稿情報の取得に失敗しました: ' + JSON.stringify(data));
  }

  return {
    likes: post.likeCount || 0,
    reposts: post.repostCount || 0,
    replies: post.replyCount || 0,
    quotes: post.quoteCount || 0
  };
}
```

### 4-3. 投稿予約シートのエンゲージメントを自動更新する

章3-2の「Bluesky投稿予約」シートのC列に記録したURIを使い、各投稿の最新エンゲージメントをD列以降に書き込みます。

```javascript
/**
 * シート列構成: A=投稿本文, B=投稿済みフラグ, C=投稿URI,
 *               D=likes, E=reposts, F=replies, G=quotes, H=更新日時
 */
function updateAllBlueskyPostEngagement() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bluesky投稿予約');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const uri = data[i][2]; // C列
    if (!uri) continue;

    try {
      const eng = getBlueskyPostEngagement(uri);
      sheet.getRange(i + 1, 4, 1, 4).setValues([[eng.likes, eng.reposts, eng.replies, eng.quotes]]);
      sheet.getRange(i + 1, 8).setValue(new Date()); // H列：更新日時
    } catch (e) {
      Logger.log(`URI ${uri} のエンゲージメント取得に失敗: ${e.message}`);
    }
  }
}
```

### 4-4. トリガーを追加する

| 関数 | 頻度の目安 | 目的 |
|---|---|---|
| `updateAllBlueskyPostEngagement` | 1日1回程度 | 過去の投稿のエンゲージメントを最新化 |

---

## 5. 料金・レート制限について

### 5-1. 料金

Bluesky APIは無料です。投稿・エンゲージメント取得ともに費用はかかりません。

### 5-2. レート制限

Blueskyのレート制限は「ポイント制」で管理されています。

| 項目 | 上限 |
|---|---|
| 1時間あたりのポイント | 5,000ポイント |
| 1日あたりのポイント | 35,000ポイント |
| 投稿（レコード作成）1件のコスト | 3ポイント |
| 換算した投稿数上限 | 1時間あたり最大1,666件、1日あたり最大11,666件 |

この制限は通常のBlueskyユーザーや大半の開発者には影響しない水準で、全アカウントを片っ端にフォローしたり全投稿にいいねしたりするような悪質なボットを制限するために設けられています。 GASで1日数回投稿する程度であれば、まず問題になりません。

エンゲージメント取得に使う `public.api.bsky.app` の公開エンドポイントについても、クライアントアプリ向けに寛容な制限が設定されています。

### 5-3. 補足：OAuthとアプリパスワードについて

Blueskyは新規プロジェクト向けに正式なOAuth認証の利用を推奨する方針を示していますが、個人が自分のアカウントで使うスクリプト用途では、本手順書で使ったアプリパスワード方式は現在も問題なく利用できます。将来的に複数ユーザー向けのサービスを作る場合は、OAuthへの移行を検討してください。

---

## 6. 注意点・トラブルシューティング

- **`401 Unauthorized` になる**：`accessJwt` が失効している可能性があります。`bluesky_refreshSession()` を実行するか、投稿関数内の自動リトライが機能しているか確認してください。
- **`bluesky_refreshSession` も失敗する**：`refreshJwt`（約2ヶ月）自体が失効しています。`bluesky_login()` を再実行してください。
- **投稿できるがエンゲージメントが0のまま**：`getAuthorFeed` / `getPostThread` は反映まで数秒〜数十秒のタイムラグがあることがあります。時間を置いて再取得してください。
- **文字数エラーになる**：Blueskyの投稿は300グラフェム（絵文字なども1文字としてカウント）が上限です。日本語の全角文字も1グラフェムとしてカウントされます。
- **画像を投稿したい場合**：`com.atproto.repo.uploadBlob` で画像をアップロードしてBlobを取得し、`record.embed` に `app.bsky.embed.images` として埋め込みます（別途コード例が必要であればお伝えします）。
- **アプリパスワードが漏れた・不要になった場合**：Bluesky設定画面のアプリパスワード一覧からいつでも個別に無効化できます。

---

以上で、Bluesky APIの準備からGASによる自動投稿・エンゲージメント取得の実装までが完了です。ThreadsとBluesky、両方に同時投稿したい場合は、`postToThreads` と `postToBluesky` を1つのラッパー関数から順に呼び出す構成にすることもできます（ご希望であれば追加します）。
