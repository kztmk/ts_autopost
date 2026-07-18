# Threads / Bluesky 同時投稿 統合関数の手順書

対象：これまでの「Threads自動投稿」「Bluesky自動投稿」の手順書で作成した `postToThreads(text)` と `postToBluesky(text)` を、1つのGASプロジェクトにまとめて **1回の呼び出しで両方に投稿** したい方

前提：以下の2つの手順書の内容がすでに **同じGASプロジェクト内** に実装済みであること
- 「Threads自動投稿_GASセットアップ手順書」の `postToThreads(text)`
- 「Bluesky自動投稿_GASセットアップ手順書」の `postToBluesky(text)`

（別々のGASプロジェクトに分けて実装している場合は、どちらか一方のプロジェクトに両方のコードをまとめてください。）

---

## 1. 統合投稿関数

```javascript
/**
 * ThreadsとBlueskyの両方に投稿する統合関数
 * 片方が失敗してももう片方は投稿を試みる（部分成功を許容する）
 *
 * @param {string} text 投稿本文（共通で使う場合）
 * @param {Object} [options] プラットフォームごとに文言を変えたい場合に指定
 * @param {string} [options.threadsText] Threads用の本文（省略時はtextを使用）
 * @param {string} [options.blueskyText] Bluesky用の本文（省略時はtextを使用）
 * @return {Object} { threads: MediaID|null, bluesky: AT URI|null, errors: string[] }
 */
function postToAll(text, options) {
  options = options || {};
  const threadsText = options.threadsText || text;
  const blueskyText = options.blueskyText || text;

  const results = { threads: null, bluesky: null, errors: [] };

  try {
    results.threads = postToThreads(threadsText);
  } catch (e) {
    results.errors.push('Threads: ' + e.message);
    Logger.log('Threads投稿失敗: ' + e.message);
  }

  try {
    results.bluesky = postToBluesky(blueskyText);
  } catch (e) {
    results.errors.push('Bluesky: ' + e.message);
    Logger.log('Bluesky投稿失敗: ' + e.message);
  }

  if (!results.threads && !results.bluesky) {
    throw new Error('両プラットフォームへの投稿に失敗しました: ' + results.errors.join(' / '));
  }

  return results;
}

/**
 * テスト実行用
 */
function testPostToAll() {
  const result = postToAll('GASからThreadsとBlueskyへ同時投稿するテストです。');
  Logger.log(JSON.stringify(result, null, 2));
}
```

> ポイント：`try/catch` を投稿ごとに分けているため、例えば「Threadsのトークンが切れていた」場合でも、Blueskyへの投稿は正常に行われます。両方失敗した場合のみエラーを投げます。

### 文字数制限の違いに注意

| プラットフォーム | 上限 |
|---|---|
| Threads | 500文字 |
| Bluesky | 300グラフェム（絵文字なども1文字扱い） |

同じ本文を使い回すと、Blueskyだけ文字数オーバーでエラーになることがあります。その場合は `options.blueskyText` に短縮版を渡してください。

```javascript
postToAll(
  '長めのThreads投稿本文をここに書きます……',
  { blueskyText: '短縮したBluesky向け本文' }
);
```

---

## 2. スプレッドシートと連携した統合予約投稿

「統合投稿予約」という名前のシートを用意し、以下の列構成にします。

| 列 | 内容 |
|---|---|
| A | 投稿本文 |
| B | 投稿済みフラグ |
| C | Threads Media ID |
| D | Bluesky 投稿URI |
| E | エラー内容（あれば） |

```javascript
function scheduledPostAll() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('統合投稿予約');
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    const [text, done] = data[i];
    if (text && !done) {
      const result = postToAll(text);
      sheet.getRange(i + 1, 2).setValue(true);                    // B列：投稿済み
      sheet.getRange(i + 1, 3).setValue(result.threads || '');    // C列：Threads Media ID
      sheet.getRange(i + 1, 4).setValue(result.bluesky || '');    // D列：Bluesky URI
      sheet.getRange(i + 1, 5).setValue(result.errors.join(' / ')); // E列：エラー（あれば）
      break; // 1回のトリガーで1件だけ投稿する場合
    }
  }
}
```

### トリガー設定

| 関数 | 頻度の目安 | 目的 |
|---|---|---|
| `scheduledPostAll` | 投稿したいタイミング（例：毎日9時） | Threads・Bluesky同時の自動投稿 |
| `refreshThreadsToken`（Threads手順書） | 7〜14日ごと | Threadsトークンの延命 |
| `bluesky_refreshSession`（Bluesky手順書） | 1週間に1回程度 | Blueskyトークンの延命 |

---

## 3. 動作確認

1. `testPostToAll` を手動実行し、実行ログで `threads` と `bluesky` の両方に値が入っているか確認
2. Threads・Bluesky双方のアプリを開き、実際に投稿されているか確認
3. わざとThreadsのトークンを無効化するなどして、片方だけ失敗した場合に **もう片方は投稿され、`errors` にエラー内容が記録される** ことを確認しておくと安心です

---

以上で、ThreadsとBlueskyへの同時投稿を1つの関数（`postToAll`）にまとめる実装が完了です。
