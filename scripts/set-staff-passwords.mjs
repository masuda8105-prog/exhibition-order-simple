import process from "node:process";
import { createClient } from "@supabase/supabase-js";

const dryRun = process.argv.includes("--dry-run");
const verify = process.argv.includes("--verify");
const url = process.env.SUPABASE_URL?.trim();
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
const commonPassword = process.env.EXHIBITION_COMMON_PASSWORD;

if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です。");
}
if (!dryRun && !commonPassword) {
  throw new Error("EXHIBITION_COMMON_PASSWORD が必要です。");
}
if (verify && !anonKey) {
  throw new Error("--verify には SUPABASE_ANON_KEY が必要です。");
}

const admin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const { data: staffRows, error: staffError } = await admin
  .from("exhibition_staff")
  .select("user_id,display_name,active")
  .eq("active", true)
  .order("display_name");
if (staffError) throw staffError;
if (!staffRows?.length) throw new Error("有効な展示会スタッフが0件です。");

const users = [];
for (let page = 1; ; page += 1) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) throw error;
  users.push(...data.users);
  if (!data.nextPage) break;
}

const usersById = new Map(users.map((user) => [user.id, user]));
const targets = staffRows.map((staff) => {
  const user = usersById.get(staff.user_id);
  if (!user?.email) throw new Error(`Authユーザーまたはメールがありません: ${staff.display_name}`);
  return { staff, user };
});

const maskEmail = (email) => {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
};

console.log(`対象スタッフ: ${targets.length}名`);
for (const { staff, user } of targets) {
  console.log(`- ${staff.display_name}: ${maskEmail(user.email)}`);
}

if (dryRun) {
  console.log("ドライランのためパスワードは変更していません。");
  process.exit(0);
}

for (const { staff, user } of targets) {
  const { error } = await admin.auth.admin.updateUserById(user.id, { password: commonPassword });
  if (error) throw new Error(`${staff.display_name} のパスワード更新に失敗: ${error.message}`);
}
console.log(`パスワード更新完了: ${targets.length}名`);

if (verify) {
  for (const { staff, user } of targets) {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email: user.email,
      password: commonPassword,
    });
    if (signInError) throw new Error(`${staff.display_name} のログイン確認に失敗: ${signInError.message}`);

    const { data: profile, error: profileError } = await client
      .from("exhibition_staff")
      .select("display_name")
      .eq("user_id", user.id)
      .eq("active", true)
      .single();
    if (profileError || profile?.display_name !== staff.display_name) {
      throw new Error(`${staff.display_name} のスタッフ権限確認に失敗しました。`);
    }

    const { count, error: productError } = await client
      .from("products")
      .select("product_no", { count: "exact", head: true });
    if (productError || !count) {
      throw new Error(`${staff.display_name} の商品参照確認に失敗しました。`);
    }
    await client.auth.signOut();
  }
  console.log(`ログイン・スタッフ権限・商品参照確認完了: ${targets.length}名`);
}
