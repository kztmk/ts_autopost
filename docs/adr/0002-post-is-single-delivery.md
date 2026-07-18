# Post は単一の PlatformAccount 宛の1配信とする（ファンアウト型の不採用）

初期ドラフトには「1つの本文を Threads と Bluesky に同時に撃ち、部分成功を許容する `postToAll`」というファンアウト型の設計があったが、採用しない。Post は常にちょうど1つの `(platform, accountId)` に紐付く1行とし、クロスポストはフロントエンドが複数行を一括作成（`createMultiple`）する操作に還元する。部分失敗の再送・プラットフォーム別の本文差し替え（Threads 500字 / Bluesky 300グラフェム）・投稿IDやエラーの記録・アーカイブが、すべて x_Autopost 由来の行単位機構のままで解決できるため。UI 上のグループ表示が必要になれば `crossPostGroupId` 列で担保する。
