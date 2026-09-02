import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "dist", ".temp", ".branches"]);
const forbiddenNames = new Set(["products.json", "product_master.csv", "online-config.js"]);
const forbiddenExtensions = new Set([".csv", ".xls", ".xlsx"]);
const textExtensions = new Set([".js", ".mjs", ".ts", ".html", ".css", ".md", ".json", ".toml", ".sql", ".yml", ".yaml", ".env"]);
const secretPatterns = [
  { name: "service role JWT", pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/ },
  { name: "Supabase secret key", pattern: /sb_secret_[a-zA-Z0-9_-]{20,}/ },
  { name: "generic secret key", pattern: /(?:sk_live|sk_test|ghp|github_pat)_[a-zA-Z0-9_-]{20,}/ },
  { name: "non-empty service role assignment", pattern: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*(?!(?:YOUR_|<|\$|\{|\[REDACTED\]))[^\s#][^\r\n]*/ },
];

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath, files);
    else files.push(fullPath);
  }
  return files;
}

const findings = [];
for (const file of await walk(root)) {
  const name = relative(root, file).replaceAll("\\", "/");
  const extension = extname(file).toLowerCase();
  if (forbiddenNames.has(name.split("/").at(-1)) || forbiddenExtensions.has(extension)) findings.push(`${name}: 非公開データ形式`);
  if (!textExtensions.has(extension) && !name.endsWith(".env.example")) continue;
  if ((await stat(file)).size > 2_000_000) continue;
  const content = await readFile(file, "utf8");
  for (const check of secretPatterns) {
    if (check.pattern.test(content) && name !== ".env.example" && name !== "scripts/audit-public-repo.mjs") findings.push(`${name}: ${check.name}`);
  }
}

if (findings.length) {
  console.error("公開前監査で問題を検出しました:");
  findings.forEach((finding) => console.error(`- ${finding}`));
  process.exit(1);
}
console.log("公開前監査: 非公開マスタ、表計算ファイル、既知の秘密キー形式は検出されませんでした。");
