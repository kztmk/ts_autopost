// esbuild が生成した dist/code.js から IIFE ラッパーを剥がす。
//  - 2 行目 `var MyApp = (() => {` を削除
//  - `return __toCommonJS(index_exports);` 行から末尾（`})();` とフッター）までを削除
// 結果、バンドル内の各トップレベル関数がそのまま GAS のグローバル関数になる。
const fs = require("fs");
const filePath = "dist/code.js";

try {
  const data = fs.readFileSync(filePath, "utf8");
  let lines = data.split("\n");

  if (lines.length < 3) {
    console.error("dist/code.js の行数が足りません。");
    process.exit(1);
  }

  let returnLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("return __toCommonJS(index_exports);")) {
      returnLineIndex = i;
      break;
    }
  }

  if (returnLineIndex !== -1) {
    const removedCount = lines.length - returnLineIndex;
    lines = lines.slice(0, returnLineIndex);
    console.log(
      `${returnLineIndex + 1}行目以降 ${removedCount}行（IIFE の閉じとフッター）を削除しました。`
    );
  } else {
    console.log("'return __toCommonJS(index_exports);' が見つかりませんでした。");
  }

  // 2 行目（`var MyApp = (() => {`）を削除して IIFE を開く
  lines.splice(1, 1);

  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  console.log("IIFE ラッパーを剥がしました。");
} catch (err) {
  console.error("エラー:", err);
  process.exit(1);
}
