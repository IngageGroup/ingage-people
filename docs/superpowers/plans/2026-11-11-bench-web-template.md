# Ingage Bench Web Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A GitHub template repo that gives a new bench team a signed-in, Ingage-styled Next.js
app with a Postgres-backed `notes` sample, unit + E2E tests, CI/CD to Azure dev and prod, and a
README that gets them there with `az` commands.

**Architecture:** Next.js 16 App Router app with an Auth.js (Entra ID) fail-closed gate in
`src/proxy.ts`. Drizzle over `pg` with two connection modes (password URL locally / Entra token
per connection in Azure). Migrations run from `instrumentation.ts` at production start under a
Postgres advisory lock. Image built once, pushed to dev ACR, then carried to prod ACR as a
workflow artifact.

**Tech Stack:** Node 22, pnpm, Next.js 16, React 19, TypeScript 5.9, next-auth v5, Zod 4,
drizzle-orm + drizzle-kit + pg, @azure/identity, @azure/monitor-opentelemetry,
@ingagegroup/ingage-react + ingage-design-tokens, Tailwind 4, Biome, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-11-bench-web-template-design.md`

**Reference implementation:** `~/src/skills-upload` (read-only). Where a step says "as in
skills-upload", copy that file and strip anything Skill Depot-specific.

## Global Constraints

- Node 22; `packageManager` pnpm (use skills-upload's `pnpm@10.29.3` unless a newer stable exists).
- Exact version pins only (no `^`/`~`). Start from skills-upload's pins; look up current stable
  for new packages (`drizzle-orm`, `drizzle-kit`, `pg`, `@types/pg`, `@azure/identity`,
  `@azure/monitor-opentelemetry`) with `pnpm view <pkg> version` at build time.
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440` (user supply-chain standard).
- `.npmrc` points `@ingagegroup` at `https://npm.pkg.github.com` with `${NODE_AUTH_TOKEN}`.
- TypeScript strict flags exactly as skills-upload's `tsconfig.json`.
- Biome clean, `tsc --noEmit` clean, all tests pass, zero warnings.
- No real secrets, tenant IDs, client IDs, subscription IDs or personal usernames anywhere. No
  `phillachmann` registry username, no PATs.
- No Skill Depot names, domains or code paths (`rg -i 'skill|depot|octokit|github app'` over
  `src e2e README.md CLAUDE.md` must find nothing template-irrelevant).
- **Rename marker:** every spot a team renames contains `bench-web-template` (slugs: package
  name, image name) or `Bench Web Template` (display name), or `<APPNAME>`-style placeholders in
  shell/README. The README checklist finds them with
  `rg -n -i 'bench.web.template|<APPNAME>|<[A-Z_]+_ID>'`.
- Display name lives in exactly one code constant: `APP_NAME` in `src/lib/app-config.ts`.
- Bypass identity: `E2E_USER_EMAIL = "e2e@example.com"`.
- `ALLOWED_EMAIL_DOMAIN` default in `.env.local.example`: `ingagepartners.com`.
- Notes title: trimmed, 1–200 chars.
- Default region placeholder `eastus2`. Resource groups `rg-<APPNAME>-dev`, `rg-<APPNAME>-prod`.
- Azure access contact in README: `phil.lachmann@ingagepartners.com`.
- Postgres Entra token scope: `https://ossrdbms-aad.database.windows.net/.default`.
- Design rules: tokens for color/type via `style={{ color: "var(--…)" }}`, Tailwind for layout
  only, one primary (orange) `Button` per section, title-case CTAs, no emoji, light only.
- Library gotcha: `Button` renders `<button>` with no `type` — never put it inside a `<form>`.
- GitHub Actions pinned to full SHAs with `# vX.Y.Z` comments (look up with
  `gh api repos/<owner>/<action>/git/ref/tags/<tag>`), `persist-credentials: false`,
  least-privilege `permissions`. `actionlint` and `zizmor` clean.
- Work on branch `feat/initial-template`; open one PR at the end. Commit per task.

## Review Focus

1. **Public-path prefix leaks** — `startsWith("/api/auth")` also matches `/api/authors`;
   `/api/health` would match `/api/healthz-admin`. Expect public matching on whole path segments
   only. Pinned in Task 2.
2. **Malformed POST body** — non-JSON or empty body to `POST /api/notes` must return 400 JSON,
   not a 500 crash. Pinned in Task 4.
3. **Hanging DB makes health probe hang** — a DB that accepts TCP but never answers must not
   leave `/api/health` stuck past the probe timeout; expect 503 within ~5 s. Pinned in Task 3
   (pool `connectionTimeoutMillis`) and Task 4 (health returns 503 when `pingDb` rejects).
4. **Two replicas start together and race migrations** — expect one to migrate, the other to
   wait, both to start. Pinned in Task 6 (advisory lock; verified by starting two containers).
5. **Notes list fails to load** — the Welcome page must show an error message, not the "no
   notes yet" empty state, when `GET /api/notes` fails. Pinned in Task 7 (E2E with routed 500).

---

### Task 1: Project scaffold that builds

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `biome.json`,
  `vitest.config.mts`, `next.config.ts`, `postcss.config.mjs`, `.gitignore`, `.npmrc`,
  `.githooks/pre-commit`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`
  (placeholder, replaced in Task 5), `src/app/icon.svg`, `src/app/favicon.ico`,
  `public/assets/logos/*.png`, `src/lib/app-config.ts`, `src/lib/app-config.test.ts`

**Interfaces:**
- Produces: `APP_NAME: string` (= `"Bench Web Template"`) and `APP_DESCRIPTION: string` from
  `@/lib/app-config`. `@/*` alias → `./src/*` in tsconfig and vitest.

- [ ] **Step 1:** `git switch -c feat/initial-template`.
- [ ] **Step 2:** Write `package.json`: name `bench-web-template`; scripts as skills-upload plus
  `"typecheck": "tsc --noEmit"`, `"db:generate": "drizzle-kit generate"`,
  `"db:migrate": "drizzle-kit migrate"`; `lint`/`format` cover `./src ./e2e`. Dependencies: the
  spec's stack list only (drop octokit, adm-zip, gray-matter, react-markdown, rehype/remark).
  `pnpm-workspace.yaml` holds `minimumReleaseAge: 1440` and `onlyBuiltDependencies: [sharp]`.
- [ ] **Step 3:** Copy `tsconfig.json`, `biome.json` (extend `files.includes` with `e2e/**`),
  `vitest.config.mts`, `postcss.config.mjs`, `.npmrc`, `.githooks/pre-commit`, `.gitignore`,
  `icon.svg`, `favicon.ico`, and the four logo PNGs from skills-upload. Copy `next.config.ts`
  unchanged except add `serverExternalPackages: ["@azure/monitor-opentelemetry", "pg"]` only if
  the Task 6 build needs it (decide there; do not add speculatively).
- [ ] **Step 4:** `globals.css`: skills-upload's file minus `.markdown` and `.field-textarea`.
  `layout.tsx`: skills-upload's, metadata from `APP_NAME`/`APP_DESCRIPTION`, no `AppChrome` yet.
- [ ] **Step 5:** Test `app-config.test.ts`: `expect(APP_NAME).toBe("Bench Web Template")`.
- [ ] **Step 6:** Run `export NODE_AUTH_TOKEN=$(gh auth token) && pnpm install && pnpm audit
  --audit-level=moderate && pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
  Expected: all succeed, no warnings.
- [ ] **Step 7:** Commit `Scaffold Next.js app with Ingage design system`.

### Task 2: Auth gate, domain restriction, bypass, current user

**Files:**
- Create: `src/lib/e2e-bypass.ts`, `src/lib/auth.ts`, `src/proxy.ts`,
  `src/app/api/auth/[...nextauth]/route.ts`
- Test: `src/lib/e2e-bypass.test.ts`, `src/lib/auth.test.ts`, `src/proxy.test.ts`

**Interfaces:**
- Produces: `isAuthBypassed(): boolean`; `E2E_USER_EMAIL = "e2e@example.com"` (exported from
  `e2e-bypass.ts`); `isAllowedEmail(candidate: unknown): boolean`; `handlers`, `auth` from
  `@/lib/auth`; `getCurrentUserEmail(): Promise<string | null>` from `@/lib/auth`;
  `isPublicPath(pathname: string): boolean`, `decideAccess(...)`, `createGate(...)` from
  `@/proxy`.

- [ ] **Step 1:** Port skills-upload's three test files, dropping `requireAdmin` tests. Add:
  - `isPublicPath`: `/api/health` → true; `/api/auth/session` → true; `/api/authors` → false;
    `/api/healthz` → false; `/auth/signin-other` → false; `/assets/logos/x.png` → true;
    `/assets/logosx/x.png` → false; `/` → false; `/api/notes` → false.
  - `getCurrentUserEmail`: bypass on → `"e2e@example.com"` without calling `auth`; bypass on +
    `NODE_ENV=production` + no session → `null`; session `{ user: { email: "a@x.com" } }` →
    `"a@x.com"`; no session → `null`.
- [ ] **Step 2:** Run `pnpm test src/lib src/proxy.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement. `e2e-bypass.ts` and `auth.ts` as skills-upload minus admin code,
  plus `getCurrentUserEmail`. `proxy.ts` as skills-upload with `/api/health` added and
  `isPublicPath` matching a public entry only when `pathname === entry` or
  `pathname.startsWith(entry + "/")` (entries stored without trailing slash).
- [ ] **Step 4:** Run the tests. Expected: PASS. Run `pnpm lint && pnpm typecheck`.
- [ ] **Step 5:** Commit `Add fail-closed auth gate with Entra sign-in`.

### Task 3: Database layer and local Postgres

**Files:**
- Create: `docker-compose.yml`, `drizzle.config.ts`, `src/db/schema.ts`, `src/db/config.ts`,
  `src/db/index.ts`, `src/db/notes.ts`, `drizzle/` (generated)
- Test: `src/db/config.test.ts`

**Interfaces:**
- Produces:
  - `notes` table (`schema.ts`): `id uuid pk defaultRandom`, `title varchar(200) not null`,
    `createdBy text not null` (column `created_by`), `createdAt timestamptz not null defaultNow`
    (column `created_at`). `type Note = typeof notes.$inferSelect`.
  - `getPoolConfig(env: NodeJS.ProcessEnv, getToken: () => Promise<string>): PoolConfig` in
    `config.ts` (pure, `getToken` injected).
  - `createEntraTokenProvider(clientId: string | undefined): () => Promise<string>` in
    `config.ts` — wraps `DefaultAzureCredential({ managedIdentityClientId })`, scope from Global
    Constraints, fetches per call (no caching at startup).
  - `getPool(): Pool`, `getDb(): NodePgDatabase<typeof schema>`, `pingDb(): Promise<void>` in
    `index.ts` — lazy singletons; nothing connects at import time.
  - `listNotes(): Promise<Note[]>` (newest first), `createNote(input: { title: string;
    createdBy: string }): Promise<Note>` in `notes.ts`.

- [ ] **Step 1:** Write `config.test.ts`:
  - `DATABASE_URL` set → `{ connectionString: <url>, connectionTimeoutMillis: 5000 }` and
    `getToken` not called.
  - `PGHOST`/`PGDATABASE`/`PGUSER` set, no URL → `host`, `database`, `user`, `port: 5432`,
    `ssl: true`, `connectionTimeoutMillis: 5000`, and `password` is a function that resolves to
    the injected token; calling it twice calls `getToken` twice.
  - Neither set → throws an Error whose message names `DATABASE_URL` and `PGHOST`.
  - Only `PGHOST` set → throws naming the missing `PGDATABASE` and `PGUSER`.
- [ ] **Step 2:** Run `pnpm test src/db`. Expected: FAIL.
- [ ] **Step 3:** Implement `config.ts`, `schema.ts`, `index.ts`, `notes.ts`. `pg` accepts
  `password` as an async function, called per new connection — that is how tokens stay fresh.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** `docker-compose.yml`: one `postgres` service (current stable major, pinned
  tag), user/password/db `app`/`app`/`app`, port `5432:5432`, named volume, `pg_isready`
  healthcheck. `drizzle.config.ts`: dialect `postgresql`, schema `./src/db/schema.ts`, out
  `./drizzle`, `dbCredentials.url` from `DATABASE_URL` (load `.env.local` via `dotenv` when the
  variable is unset; throw a clear error if still unset).
- [ ] **Step 6:** Run `docker compose up -d && DATABASE_URL=postgres://app:app@localhost:5432/app
  pnpm db:generate && DATABASE_URL=… pnpm db:migrate`. Expected: one SQL file in `drizzle/`,
  `psql … -c '\d notes'` shows the four columns.
- [ ] **Step 7:** Commit `Add Drizzle schema, connection modes and notes queries`.

### Task 4: Notes and health APIs

**Files:**
- Create: `src/lib/validation.ts`, `src/app/api/notes/route.ts`, `src/app/api/health/route.ts`
- Test: `src/lib/validation.test.ts`, `src/app/api/notes/route.test.ts`,
  `src/app/api/health/route.test.ts`

**Interfaces:**
- Consumes: `getCurrentUserEmail` (Task 2), `listNotes`, `createNote`, `pingDb`, `Note`
  (Task 3).
- Produces: `createNoteSchema` (Zod) and `type CreateNoteInput`. Response shapes (the UI in
  Task 5 relies on these):
  - `GET /api/notes` 200 → `{ notes: Array<{ id, title, createdBy, createdAt: string }> }`
  - `POST /api/notes` 201 → `{ note: {…same…} }`; 400 → `{ error: string }`; 401 →
    `{ error: "Unauthorized" }`; 500 → `{ error: "Database error", correlationId: string }`
  - `GET /api/health` 200 → `{ status: "ok" }`; 503 → `{ status: "unavailable" }`

- [ ] **Step 1:** Write tests.
  - Schema: `""` → error "Title is required"; `"   "` → same; 201 chars → "Title must be 200
    characters or fewer"; 200 chars → ok; `"  hi  "` → `"hi"`; `123`/`null`/missing → error;
    `{ title: "x", created_by: "evil@x.com" }` → parsed object has no `created_by`.
  - Notes routes (mock `@/lib/auth` and `@/db/notes`): GET returns notes; GET with `listNotes`
    rejecting → 500 and `console.error` called with a message containing the correlation id;
    POST valid → 201 and `createNote` called with `{ title: "hi", createdBy: "a@x.com" }` even
    when body has `created_by`; POST empty title → 400 with the schema message; POST non-JSON
    body (`"not json"`) → 400 `{ error: "Request body must be JSON" }`; POST with
    `getCurrentUserEmail` → `null` → 401 and `createNote` not called; POST `createNote` rejects
    → 500.
  - Health (mock `@/db`): `pingDb` resolves → 200 ok; rejects → 503 and error logged.
- [ ] **Step 2:** Run `pnpm test src/lib/validation.test.ts src/app/api`. Expected: FAIL.
- [ ] **Step 3:** Implement. Both routes export `const dynamic = "force-dynamic"`. Log DB errors
  as `` console.error(`[api/notes ${correlationId}] <operation> failed`, err) ``.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then `pnpm lint && pnpm typecheck`.
- [ ] **Step 5:** Commit `Add notes and health API routes`.

### Task 5: App shell, sign-in page, Welcome page

**Files:**
- Create: `src/components/AppChrome.tsx`, `src/components/PageHeader.tsx`,
  `src/components/EmptyState.tsx`, `src/app/auth/signin/page.tsx`,
  `src/app/NotesPanel.tsx`
- Modify: `src/app/layout.tsx` (wrap in `SessionProvider` + `AppChrome`), `src/app/page.tsx`

**Interfaces:**
- Consumes: `APP_NAME`; API shapes from Task 4.

- [ ] **Step 1:** `AppChrome`: skills-upload's minus admin fetch; one sidebar section with item
  `{ id: "/", label: "Welcome", icon: <pick an existing IconName> }`; `appName={APP_NAME}`,
  `homeHref="/"`. `PageHeader`, `EmptyState`: copy as-is. Sign-in page: copy, heading
  `APP_NAME`.
- [ ] **Step 2:** `page.tsx` (server component): `PageHeader` titled `Welcome` with one-paragraph
  intro (what the template provides: Entra sign-in, Postgres via Drizzle, tests, CI/CD) and a
  pointer to the README; then `<NotesPanel />`.
- [ ] **Step 3:** `NotesPanel` (`"use client"`): fetches `/api/notes` on mount. States:
  loading; error → `Toast tone="error"` with "Could not load notes."; empty → `EmptyState`
  titled "No notes yet"; rows → `TableListHeading` + `TableListLine` with columns Title, Created
  By, Created At (`Intl.DateTimeFormat` medium date + short time). Add form: `Input` labelled
  "Title" + primary `Button` "Add Note" — no `<form>`; Enter in the input triggers add; button
  disabled while a request is in flight; a 400 shows the server's `error` in `Input`'s `error`
  prop; success clears the input and refetches.
- [ ] **Step 4:** Run `docker compose up -d`, migrate, then `E2E_AUTH_BYPASS=true
  DATABASE_URL=… AUTH_SECRET=dev pnpm dev`. Open `http://localhost:3000`: AppShell renders,
  empty state shows, adding "First note" shows a row by `e2e@example.com`, adding blank shows
  "Title is required". Open `/auth/signin`: card with logo and "Sign in with Microsoft".
- [ ] **Step 5:** `pnpm lint && pnpm typecheck && pnpm build`. Commit
  `Add app shell, sign-in page and Welcome page with notes`.

### Task 6: Startup migrations, telemetry, container image

**Files:**
- Create: `src/db/migrate.ts`, `instrumentation.ts` (at `src/instrumentation.ts`), `Dockerfile`,
  `.dockerignore`
- Test: `src/db/migrate.test.ts`

**Interfaces:**
- Consumes: `getPoolConfig`, `createEntraTokenProvider` (Task 3).
- Produces: `runMigrations(options?: { migrationsFolder?: string }): Promise<void>` — default
  folder `path.join(process.cwd(), "drizzle")`. `MIGRATION_LOCK_ID` constant (any fixed bigint).

- [ ] **Step 1:** Write `migrate.test.ts` (mock `pg` `Client` and drizzle's `migrate`): calls in
  order `connect`, `SELECT pg_advisory_lock($1)`, `migrate`, `SELECT pg_advisory_unlock($1)`,
  `end`; when `migrate` rejects, unlock and `end` still run and the error is rethrown.
- [ ] **Step 2:** Run it. Expected: FAIL. Implement `runMigrations` with a single `pg.Client`
  built from `getPoolConfig(process.env, createEntraTokenProvider(process.env.AZURE_CLIENT_ID))`.
  Run again. Expected: PASS.
- [ ] **Step 3:** `instrumentation.ts` `register()`: return unless `NEXT_RUNTIME === "nodejs"`;
  if `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, dynamically import
  `@azure/monitor-opentelemetry` and call `useAzureMonitor()`; if `NODE_ENV === "production"`,
  `await runMigrations()`, on failure log `[migrate] failed; exiting` with the error and
  `process.exit(1)`. Check `node_modules/next/dist/docs/` to confirm `register` is awaited
  before the server serves requests and that dynamic imports in it work with `standalone`.
- [ ] **Step 4:** `Dockerfile`: skills-upload's, plus `COPY --from=builder /app/drizzle
  ./drizzle` in the runner stage. `.dockerignore`: skills-upload's (keep `drizzle/` included).
- [ ] **Step 5:** Verify:
  - `docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN -t bench-web-template .`
  - Fresh DB (`docker compose down -v && docker compose up -d`), then run two containers at once
    against it (`--network host` or `host.docker.internal`, `DATABASE_URL`, `AUTH_SECRET`,
    ports 3000/3001). Expected: both log ready; `curl :3000/api/health` and `:3001` → 200
    `{"status":"ok"}`; `notes` table exists once.
  - Run one with `DATABASE_URL=postgres://app:wrong@…`. Expected: logs `[migrate] failed;
    exiting`, container exit code 1.
  - `docker compose stop postgres` with a healthy container running → `/api/health` returns 503
    within 6 s.
- [ ] **Step 6:** Commit `Run migrations at startup and add container image`.

### Task 7: E2E tests

**Files:**
- Create: `playwright.config.ts`, `.env.test`, `e2e/db.ts`, `e2e/welcome.spec.ts`,
  `e2e/notes.spec.ts`, `e2e/signin.spec.ts`, `e2e/health.spec.ts`

**Interfaces:**
- Produces: `resetNotes(): Promise<void>` in `e2e/db.ts` (`TRUNCATE notes` via `pg` using
  `DATABASE_URL` from `.env.test`).

- [ ] **Step 1:** `.env.test` (committed, local-only values): `E2E_AUTH_BYPASS=true`,
  `AUTH_SECRET=test-secret-for-e2e-only`,
  `DATABASE_URL=postgres://app:app@localhost:5432/app`. `playwright.config.ts`: skills-upload's
  with `fullyParallel: false`, `workers: 1` (tests share one database), `webServer.env` also
  passing `DATABASE_URL`.
- [ ] **Step 2:** Specs:
  - welcome: banner shows `APP_NAME`; heading "Welcome"; sidebar item "Welcome".
  - notes (`beforeEach(resetNotes)`): empty state "No notes yet"; add "Buy milk" → row with
    "Buy milk" and "e2e@example.com"; add with blank title → "Title is required" visible and no
    row; route `**/api/notes` GET to status 500 → "Could not load notes." visible and "No notes
    yet" not visible.
  - signin: `/auth/signin` shows heading `APP_NAME` and enabled "Sign in with Microsoft" button.
  - health: `request.get("/api/health")` → 200 `{ status: "ok" }`.
- [ ] **Step 3:** Run `docker compose up -d && pnpm db:migrate && pnpm test:e2e`. Expected: all
  pass on both projects. Break one assertion, confirm failure, restore.
- [ ] **Step 4:** Commit `Add Playwright E2E tests`.

### Task 8: CI/CD workflows and Dependabot

**Files:**
- Create: `.github/workflows/lint-format.yml`, `unit-tests.yml`, `e2e-tests.yml`, `deploy.yml`,
  `.github/dependabot.yml`

- [ ] **Step 1:** PR workflows as skills-upload's with Global Constraints pinning applied and
  dummy `ANTHROPIC_API_KEY`/`SERPAPI_API_KEY` removed. `lint-format` also runs `pnpm typecheck`.
  `unit-tests` runs `pnpm test -- --coverage`. `e2e-tests` adds a `postgres` service container
  (same image as compose, health-checked), sets `DATABASE_URL`, runs `pnpm db:migrate` before
  `pnpm test:e2e --project=desktop-chrome`.
- [ ] **Step 2:** `deploy.yml` on push to `main` + `workflow_dispatch`, three jobs:
  - `build` (no Azure; `contents: read`, `packages: read`): `docker build` with secret
    `node_auth_token=${{ secrets.GITHUB_TOKEN }}`, tag `bench-web-template:${{ github.sha }}`,
    `docker save | gzip` → `upload-artifact` (retention 7 days).
  - `deploy-dev` (`environment: dev`, `id-token: write`, needs build): download, `docker load`,
    `azure/login` OIDC with env secrets `AZURE_CLIENT_ID`/`AZURE_TENANT_ID`/
    `AZURE_SUBSCRIPTION_ID`, `az acr login --name "$ACR_NAME"`, tag + push
    `$ACR_NAME.azurecr.io/bench-web-template:$SHA`, `az containerapp update --image …`. Env vars
    `ACR_NAME`, `CONTAINER_APP`, `RESOURCE_GROUP` from environment `vars`.
  - `deploy-prod` (`environment: prod`, needs deploy-dev): same steps against prod vars/secrets.
  - Pass `${{ }}` values into `run:` through `env:`, never inline (zizmor template injection).
- [ ] **Step 3:** `dependabot.yml`: `npm` (directory `/`) and `github-actions`, weekly,
  `cooldown: { default-days: 7 }`, one group per ecosystem; `npm` registry entry for
  `npm.pkg.github.com` scoped to `@ingagegroup` using `secrets.DEPENDABOT_PACKAGES_TOKEN`
  (README documents creating it).
- [ ] **Step 4:** Run `actionlint .github/workflows/ && zizmor .github/workflows/`. Expected: no
  findings.
- [ ] **Step 5:** Commit `Add CI workflows, deploy pipeline and Dependabot`.

### Task 9: README, agent docs, env example

**Files:**
- Create: `README.md`, `CLAUDE.md`, `AGENTS.md`, `.env.local.example`

- [ ] **Step 1:** `.env.local.example`: skills-upload's structure with only this app's vars —
  `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID`, `AUTH_SECRET`,
  `ALLOWED_EMAIL_DOMAIN="ingagepartners.com"`, `DATABASE_URL=postgres://app:app@localhost:5432/app`,
  commented `E2E_AUTH_BYPASS=true`, and a note that `PGHOST`/`PGDATABASE`/`PGUSER`/
  `AZURE_CLIENT_ID`/`APPLICATIONINSIGHTS_CONNECTION_STRING`/`AUTH_URL` are Azure-only.
- [ ] **Step 2:** `README.md` with the spec's 13 sections in order. Provisioning specifics the
  plan fixes:
  - One variables block: `SUBSCRIPTION_ID=<SUBSCRIPTION_ID>`, `TENANT_ID=<TENANT_ID>`,
    `LOCATION=eastus2`, `APPNAME=<APPNAME>`, `ENV=dev`; derived `RG=rg-$APPNAME-$ENV`,
    `ACR=acr${APPNAME}${ENV}`, `KV=kv-$APPNAME-$ENV`, `PG=pg-$APPNAME-$ENV`,
    `ID=id-$APPNAME-$ENV`, `LAW`, `AI`, `CAE`, `APP`. State `APPNAME` rules: lowercase letters
    and digits, ≤ 13 chars (so `kv-<APPNAME>-prod` fits 24).
  - First image: built locally (`docker build --platform linux/amd64 --secret …`) and pushed
    with `az acr login` before `az containerapp create`, so the app never starts from a
    placeholder image.
  - Postgres: Entra auth on, password auth off; firewall `0.0.0.0` + optional developer IP;
    Entra admin = the person running the commands; managed identity created as a DB role with
    `pgaadauth_create_principal_with_oid` via `psql` using an `az account get-access-token
    --resource-type oss-rdbms` token, then `GRANT ALL ON DATABASE` and `GRANT ALL ON SCHEMA
    public`.
  - Container App: user-assigned identity, `--registry-identity`, Key Vault secret references
    (`keyvaultref:…,identityref:…`) for `auth-secret` and `entra-client-secret`; probes on
    `/api/health` port 3000 applied with `az containerapp update --yaml` from a heredoc.
  - OIDC: one Entra app per environment, federated credential subject
    `repo:IngageGroup/<REPO>:environment:<ENV>`, roles `AcrPush` on the ACR and `Contributor`
    on the Container App.
  - Every `az` flag checked against `az <command> --help` on the current CLI (flag names for
    Postgres Entra auth changed across versions).
  - Rename checklist uses the `rg` command from Global Constraints.
- [ ] **Step 3:** `CLAUDE.md` modeled on skills-upload's sections (overview, setup, stack,
  structure, commands, design-system rules + gotchas, key patterns: auth gate, DB connection
  modes, startup migrations; env vars; conventions; gotchas incl. private registry token and the
  Vitest exclude). Keep the Next.js agent-rules block. `AGENTS.md`: one line pointing to
  `CLAUDE.md`, plus the agent-rules block.
- [ ] **Step 4:** Leftover and secret scan: the Skill Depot `rg` from Global Constraints finds
  nothing; `rg -n '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'` finds no real
  GUIDs; `rg -n 'phillachmann|ghp_|github_pat_'` finds nothing.
- [ ] **Step 5:** Full check: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test &&
  pnpm build && pnpm test:e2e`. Commit `Add README, agent docs and env example`.
- [ ] **Step 6:** Push the branch and open a PR to `main`.
