import { createHash } from "node:crypto";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です。");
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

async function countRows(table, configure = (query) => query) {
  const { count, error } = await configure(
    admin.from(table).select("*", { count: "exact", head: true }),
  );
  if (error) throw error;
  return count;
}

const [productsTotal, productsActive, staffActive, accountsActive, ordersTotal] = await Promise.all([
  countRows("products"),
  countRows("products", (query) => query.eq("is_active", true)),
  countRows("exhibition_staff", (query) => query.eq("active", true)),
  countRows("exhibition_accounts", (query) => query.eq("is_active", true)),
  countRows("exhibition_orders"),
]);

const { data: orderVersions, error: orderError } = await admin
  .from("exhibition_orders")
  .select("id,updated_at")
  .order("id");
if (orderError) throw orderError;
const orderFingerprint = createHash("sha256")
  .update(JSON.stringify(orderVersions))
  .digest("hex")
  .slice(0, 16);

console.log(JSON.stringify({
  productsTotal,
  productsActive,
  staffActive,
  accountsActive,
  ordersTotal,
  orderFingerprint,
}, null, 2));
