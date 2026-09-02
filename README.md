# 展示会注文書作成 SIMPLE版

展示会会場で商品を入力し、前の「国内展示会注文ツール」と同じ3段階UIで注文方法・お客様情報を入力して、注文書を印刷するWebアプリです。

1. 商品を追加
2. 国内通常注文／現売り対応と商品の渡し方を選択
3. お客様情報を入力してPDF・印刷へ

注文履歴・顧客情報・売上は保存しません。商品マスタ、卸価格、帳合先候補はSupabaseへ置き、認証済みの有効スタッフだけが取得できます。

## 構成

- GitHub: HTML、CSS、JavaScript、公開ロゴ、Supabaseマイグレーション、テスト、ビルド設定
- Supabase: `products`、`exhibition_accounts`、`exhibition_staff`、Authユーザー
- ブラウザのメモリ: 商品マスタ、入力中の注文、お客様情報、印刷プレビュー
- `sessionStorage`: Supabase Authのセッション（タブを閉じると消去）
- `localStorage`: 展示会名だけ

注文・顧客を保存するSupabaseテーブルは作りません。

## セットアップ

Node.js 22以上を使用します。

```powershell
npm install
Copy-Item .env.example .env.local
```

`.env.local` にブラウザ公開用の値を設定します。Anon Key / Publishable Keyはブラウザから見えることを前提とし、RLSで保護します。

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLISHABLE_OR_ANON_KEY
```

`service_role` keyやSecret Keyを `VITE_` で始まる変数へ入れてはいけません。

## Supabaseを準備

公式CLIでプロジェクトへ接続し、マイグレーションを適用します。

```powershell
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

適用するSQLは `supabase/migrations/20260901061650_secure_products.sql` です。既存3表を再利用し、RLSを有効化、`anon` の権限を削除、`authenticated` には参照権限だけを付与します。

Supabase Dashboardで一般ユーザーの自己登録を無効にし、スタッフアカウントは管理者が作成してください。作成したAuthユーザーのUUIDを使い、有効スタッフを登録します。

```sql
insert into public.exhibition_staff (user_id, display_name, active)
values ('AUTH_USER_UUID', '増田', true);
```

国内通常注文の帳合先候補もGitHubへ置かず、Supabaseへ登録します。

```sql
insert into public.exhibition_accounts (account_name, display_order)
values ('帳合先名', 10);
```

RLS・権限・ポリシーの確認SQLは `supabase/tests/security_checks.sql` にあります。

## 商品マスタを移行

取込前に、CSVを変更せず検証できます。

```powershell
npm run products:import -- "C:\path\to\商品マスタ.csv" --dry-run
```

実際に移行するときだけ `.env.local` へ管理用キーを一時設定します。この値はローカル取込スクリプトだけが読み、ブラウザのビルドには入りません。

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
```

```powershell
npm run products:import -- "C:\path\to\商品マスタ.csv"
```

### 展示会スタッフのパスワード更新

パスワードはGitHubや `.env.example` へ保存せず、作業時だけ
`EXHIBITION_COMMON_PASSWORD` へ設定します。対象は
`exhibition_staff.active = true` のAuthユーザーだけです。

```powershell
npm run staff:passwords -- --dry-run
npm run staff:passwords -- --verify
```

実行には `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`、検証時は
`SUPABASE_ANON_KEY` も必要です。Secret Keyはブラウザへ渡しません。

取込は新しい7,980件を非アクティブ状態で追加し、全件成功後に1トランザクションで新旧を切り替えます。旧商品行は削除せず非アクティブで残るため、ロールバックできます。取込完了後は `.env.local` からservice role keyを削除する運用を推奨します。`.env.local` は `.gitignore` 対象です。

## ローカル起動・確認

```powershell
npm run dev
```

Supabase未接続のUI確認だけなら、ローカル端末限定のサンプル商品で次を開けます。

```text
http://127.0.0.1:5173/?local-development=1
```

この経路はホスト名が `localhost` または `127.0.0.1` の場合だけ有効で、本物の商品や価格は含みません。

```powershell
npm run check
npm test
npm run security:audit
npm run build
```

## GitHub Pages

`.github/workflows/deploy-pages.yml` がテスト・公開前監査・Viteビルドを行い、`dist` だけを公開します。GitHub Repository Variablesへ次を設定してください。

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

どちらもブラウザへ配信される公開値です。安全性はキーの秘匿ではなく、スタッフ認証、Postgres権限、RLSで確保します。

## 公開前監査

```powershell
npm run security:audit
```

この監査は、CSV・Excel・`products.json`・既知の秘密キー形式が公開対象へ混ざっていないかを確認します。詳細な移行監査は `SECURITY_AUDIT.md` を参照してください。
