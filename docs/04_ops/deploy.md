# 本番のデプロイと Cloudflare Access の設定

本番の構成は `docs/02_design/architecture.md` 7 章のとおり **Vercel ＋ 本番 Supabase ＋ Cloudflare Access**。
この文書は、実際にデプロイするときに上から順に行う手順書。設定はユーザー（管理者）が各サービスのダッシュボードで行う。

**ローカル開発と E2E では Cloudflare Access は不要。** `npm run dev` は 127.0.0.1 で動き、認証は Supabase Auth だけで行う。

## 全体像

```
利用者（iPhone）
   │ https://<本番ドメイン>
   ▼
Cloudflare（DNS プロキシ ＋ Zero Trust Access）   ← 許可メールアドレス以外はここで止まる
   │
   ▼
Vercel（Next.js）                                 ← アプリ本体。Supabase Auth でログイン
   │
   ▼
Supabase（本番プロジェクト: Auth / PostgreSQL / Storage）
```

二重の守り:

- **Cloudflare Access**: サイト全体を許可メールアドレスだけに開く。許可されていない人にはログイン画面すら見えない（要件 9 章「サイト全体を許可された人だけが開ける」）。
- **Supabase Auth**: アプリのログイン（メール＋パスワード）。Sign Up は無効で、アカウントは管理者が作る（architecture.md 2 章）。

## 1. Supabase（本番プロジェクト）

1. 本番用の Supabase プロジェクトを作る（開発用・E2E 用とは分ける）。
2. `supabase/migrations/` を順に適用する（`supabase db push`、または SQL エディタで `0001` から順に実行）。
   - `0003_test_orgs.sql`（テスト農園 A / B）と `0006_e2e_cleanup.sql`（E2E の掃除関数）は E2E 用。本番に入れる必要はない。
3. **Authentication → Providers → Email**: "Allow new users to sign up" を **オフ**（セルフ Sign Up を無効化）。
4. **Authentication → URL Configuration**:
   - Site URL: `https://<本番ドメイン>`
   - Redirect URLs: `https://<本番ドメイン>/**`
5. **Authentication → Users → Add user** で利用者のアカウントを作る（メール＋パスワード、Auto Confirm）。
   作ったユーザーを `profiles` で組織に紐づける（`organizations` に農家の行を作り、`profiles` に `id = auth.users.id`、`organization_id`、`display_name` を入れる）。
6. **Project Settings → API** から次を控える（アプリの環境変数になる）:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - Publishable（anon）key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role / Secret key は Vercel にも `.env` にも置かない。**

## 2. Vercel

1. GitHub のリポジトリを Vercel にインポートする（Framework: Next.js。ビルド設定は既定のまま。`prebuild` で MapLibre の worker が `public/maplibre/` にコピーされる）。
2. **Settings → Environment Variables**（Production）に次を設定する:

   | 変数 | 値 |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | 本番 Supabase の Project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 本番 Supabase の Publishable key |

   `E2E_*` は本番には不要。
3. デプロイして、`https://<プロジェクト>.vercel.app` でログイン画面が出ることを確認する（この時点ではまだ誰でも開ける。独自ドメイン ＋ Access を設定したら、Vercel の既定ドメインは使わない）。
4. **Settings → Domains** に独自ドメイン `<本番ドメイン>` を追加する。Vercel が示す DNS レコード（CNAME `cname.vercel-dns.com`、または A レコード）を控える。

## 3. Cloudflare DNS（独自ドメインを Vercel に向ける）

1. ドメインを Cloudflare に登録（ネームサーバーを Cloudflare に向ける）。
2. **DNS → Records** に Vercel が指定したレコードを追加する。例: `CNAME  app  cname.vercel-dns.com`。
   **Proxy status は "Proxied"（オレンジ雲）にする。** Access はプロキシを通る通信にしか効かない（DNS only だと素通りする）。
3. **SSL/TLS → Overview** の暗号化モードを **Full (strict)** にする（Vercel 側も HTTPS のため。Flexible だとリダイレクトループになる）。
4. Vercel の Domains でドメインが Valid になるのを待つ。

## 4. Cloudflare Zero Trust → Access（許可メールアドレスだけに開く）

1. Cloudflare ダッシュボード → **Zero Trust**（初回はチーム名を決める。Free プランで 50 ユーザーまで）。
2. **Settings → Authentication → Login methods**: 既定の **One-time PIN** があれば十分（許可メールアドレスにワンタイムコードが届く）。Google 等の IdP を足してもよい。
3. **Access → Applications → Add an application → Self-hosted**:
   - Application name: `バナナ生育記録`
   - Session Duration: `24 hours`（毎朝 1 回の認証で 1 日使える。長くするなら `1 week`。現場でワンタイムコードを受け取れない状況を考えて短くしすぎない）
   - Application domain: `<本番ドメイン>`（パスは空 = サイト全体）
   - App Launcher の表示は任意
4. **Policies → Add a policy**:
   - Policy name: `許可メール`
   - Action: **Allow**
   - Configure rules → Include → Selector **Emails** → 許可する利用者のメールアドレスを列挙する
     （同じドメインの全員を許可するなら **Emails ending in** `@example.com`）
   - 必要なら Service Auth / Bypass は作らない（全員を Allow の Emails だけで通す）
5. 保存後、シークレットウィンドウで `https://<本番ドメイン>` を開き、Cloudflare のログイン画面（メールアドレス入力）が先に出ることを確認する。
   - 許可メールでワンタイムコードを受け取り通過 → アプリのログイン画面（Supabase Auth）が出る
   - 許可していないメールでは "That account does not have access" で止まる
6. PWA の確認: Access を通過した後、iPhone の Safari で「ホーム画面に追加」。
   Access のセッション Cookie は PWA（standalone）でも共有される。セッション期限が切れたらアプリ内に Cloudflare の再認証画面が出る。
   Service Worker（`/sw.js`）と manifest（`/manifest.webmanifest`）も Access の後ろにあるので、Access を通過したブラウザでだけ登録される。

### 注意

- **Access が守るのはサイト（HTML / JS / API ルート）だけ。** Supabase（`*.supabase.co`）への通信はアプリから直接行われ、Access は通らない。Supabase 側の守りは Auth（Sign Up 無効）と RLS（`organization_id` と `current_org()`）。
- Vercel の既定ドメイン `*.vercel.app` は Access の外にある。公開を避けるなら Vercel の **Deployment Protection**（Vercel Authentication）を有効にするか、既定ドメインを独自ドメインへリダイレクトする。
- 利用者を増やすときは、(1) Access のポリシーにメールを足す、(2) Supabase の Users にアカウントを作り `profiles` で組織に紐づける、の 2 か所。
- Access のログ（Zero Trust → Logs → Access）で誰がいつ通過したか見られる。

## 5. デプロイ後の確認

- [ ] `https://<本番ドメイン>` を未許可のメールで開けない
- [ ] 許可メールで Access を通過 → アプリのログイン画面 → Supabase のアカウントでログインできる
- [ ] Sign Up の導線がどこにもない。Supabase の "Allow new users to sign up" がオフ
- [ ] iPhone でホーム画面に追加でき、standalone で起動する（アイコン・名前「バナナ記録」）
- [ ] 機内モードで、開いたことのある茎の画面が表示され、記録すると未同期件数が増える。機内モード解除で 0 に戻る
