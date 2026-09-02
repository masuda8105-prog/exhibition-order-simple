import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config({ path: resolve(".env.local"), quiet: true });
dotenv.config({ path: resolve(".env"), quiet: true });

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function productRows(csvRows) {
  if (csvRows.length < 2) throw new Error("CSVに商品行がありません。");
  const headers = csvRows[0].map((value) => value.replace(/^\uFEFF/, "").trim());
  const required = ["商品", "商品名1", "卸単価", "削除区分"];
  const positions = Object.fromEntries(required.map((name) => [name, headers.indexOf(name)]));
  positions["商品名2"] = headers.indexOf("商品名2");
  for (const name of required) {
    if (positions[name] < 0) throw new Error(`必須列「${name}」がありません。`);
  }
  const products = [];
  const seen = new Set();
  for (const row of csvRows.slice(1)) {
    const productNo = String(row[positions["商品"]] || "").trim();
    const name1 = String(row[positions["商品名1"]] || "").trim();
    const name2 = positions["商品名2"] >= 0 ? String(row[positions["商品名2"]] || "").trim() : "";
    const deleteFlag = String(row[positions["削除区分"]] || "").trim();
    const price = Math.round(Number(String(row[positions["卸単価"]] || "").replaceAll(",", "").trim()));
    if (!productNo || !name1 || !deleteFlag.startsWith("0:") || !Number.isFinite(price) || price <= 0) continue;
    if (seen.has(productNo)) throw new Error(`商品コードが重複しています: ${productNo}`);
    seen.add(productNo);
    const displayOrder = products.length + 1;
    products.push({
      product_no: productNo,
      product_name: name2 ? `${name1} ${name2}` : name1,
      wholesale_price: price,
      display_order: displayOrder,
    });
  }
  if (!products.length) throw new Error("移行対象の商品が0件です。");
  return products;
}

const argumentsList = process.argv.slice(2);
const dryRun = argumentsList.includes("--dry-run");
const sourceArgument = argumentsList.find((value) => value !== "--dry-run");
if (!sourceArgument) {
  console.error("Usage: npm run products:import -- <商品マスタ.csv> [--dry-run]");
  process.exit(1);
}

const sourcePath = resolve(sourceArgument);
const bytes = await readFile(sourcePath);
const text = new TextDecoder("shift_jis").decode(bytes);
const products = productRows(parseCsv(text));
console.log(`検証済み商品数: ${products.length.toLocaleString("ja-JP")}件`);

if (dryRun) {
  console.log("ドライランのためSupabaseは変更していません。");
  process.exit(0);
}

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(".env.local に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を設定してください。");
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const sourceBatchId = randomUUID();
const batchSize = 500;
for (let start = 0; start < products.length; start += batchSize) {
  const batch = products.slice(start, start + batchSize).map((product) => ({
    ...product,
    source_batch_id: sourceBatchId,
    is_active: false,
  }));
  const { error } = await admin.from("products").insert(batch);
  if (error) throw error;
  console.log(`取込: ${Math.min(start + batchSize, products.length).toLocaleString("ja-JP")} / ${products.length.toLocaleString("ja-JP")}件`);
}

const { data: activatedCount, error: activationError } = await admin.rpc("activate_product_import", {
  p_source_batch_id: sourceBatchId,
});
if (activationError) throw activationError;
if (Number(activatedCount) !== products.length) {
  throw new Error(`有効化件数が一致しません。expected=${products.length}, actual=${activatedCount}`);
}

console.log(`Supabase商品マスタを更新しました。取込ID: ${sourceBatchId}`);
