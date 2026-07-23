// src/ 配下の全 .ts モジュールを 1 ファイルにまとめて dist/code.js を生成する。
// esbuild は IIFE で包むため、この後 modify-codejs.js でラッパーを剥がし、
// 各モジュールのトップレベル関数を GAS のグローバル関数として露出させる。
// （関数名は全モジュールで一意にすること。衝突すると esbuild がリネームし
//  doPost などが GAS から見えなくなる。）
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "src");

function collectModules(dir) {
  let modules = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      modules = modules.concat(collectModules(full));
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      entry.name !== "index.ts"
    ) {
      const rel =
        "./" +
        path.relative(srcDir, full).replace(/\\/g, "/").replace(/\.ts$/, "");
      modules.push(rel);
    }
  }
  return modules;
}

const modules = collectModules(srcDir);
const indexContent =
  modules.map((m, i) => `import * as m${i} from "${m}";`).join("\n") +
  `\nexport { ${modules.map((_, i) => `m${i}`).join(", ")} };\n`;

const indexPath = path.join(srcDir, "index.ts");
fs.writeFileSync(indexPath, indexContent, "utf8");

esbuild
  .build({
    entryPoints: [indexPath],
    bundle: true,
    format: "iife",
    globalName: "MyApp",
    outfile: "dist/code.js",
    treeShaking: false, // GAS では全関数を残す
    minify: false,
    footer: { js: "\nObject.assign(this, MyApp);\n" },
  })
  .then(() => {
    fs.unlinkSync(indexPath);
    console.log(`Bundle completed (${modules.length} modules).`);
  })
  .catch((err) => {
    if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);
    console.error("Build failed:", err);
    process.exit(1);
  });
