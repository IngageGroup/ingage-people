# Ingage Bench Web Template — Design

Date: 2026-11-11
Status: Draft for approval

## Intent

Every new web application built on the Ingage bench should start from the same, working
foundation instead of being assembled by hand each time. This repo is that foundation: a
GitHub template repository in the IngageGroup org. A team clicks **Use this template**, renames a
few marked values, gets Azure access from Phil, and has a signed-in, design-system-styled
Next.js app talking to Postgres, with unit and E2E tests and CI/CD to dev and prod.

The stack mirrors `~/src/skills-upload` (Skill Depot) so bench apps look, build, test, and deploy
the same way. The look and feel comes from the Ingage design system
(`~/src/design-system-ingage`, packages `@ingagegroup/ingage-react` and
`@ingagegroup/ingage-design-tokens`).

## Goals

- A runnable starter: sign in with Entra → Welcome page in the Ingage AppShell → a sample
  Postgres-backed table you can add rows to.
- The same key packages, tooling, and conventions as skills-upload.
- A README that gets a new team from "Use this template" to deployed dev and prod, including
  the full Azure CLI (`az`) commands to create every resource.
- Placeholders (not real values) for every Azure resource group name, subscription, tenant, and
  Entra key.
- Starter unit tests (Vitest) and E2E tests (Playwright) that pass out of the box and show the
  patterns to follow.

## Non-goals

- Shared/common Azure resources across apps (may come later; for now every app is independent).
- A rename/bootstrap script. Renaming is a short, documented checklist of marked spots.
- Features from skills-upload that are specific to it: GitHub App integration, skills logic,
  admin allowlist, in-memory rate limiter. Teams add these back if needed.
- Dark mode (the design system is light-only).
- VNet/private networking for Postgres (noted as a future hardening step).

## Anti-goals (would make this a failure even if it works)

- Real secrets, real tenant/client IDs, or anyone's personal credentials committed anywhere
  (skills-upload's deploy script hardcodes `--registry-username phillachmann` and a personal PAT —
  must not be copied).
- Leftover Skill Depot names, domains, or code paths.
- An auth gate that can fail open, or an auth bypass that can activate in production.
- Instructions that only work for the person who wrote them (hidden manual steps).

## Decisions made by the user

- Cloud is **Azure**; all provisioning commands use the **Azure CLI (`az`)**, not AWS.
- Each app gets **two resource groups**: `rg-<APPNAME>-dev` and `rg-<APPNAME>-prod`. Each set of
  resources is fully independent (nothing shared between apps or between dev and prod).
- Starting point is GitHub's **Use this template** button (not forking) in the **IngageGroup**
  org. The README has a "Start here" section at the top explaining how, first.
- README tells people to contact **phil.lachmann@ingagepartners.com** for Azure access for a new
  application.
- Signed-in landing page is a **Welcome page with the sample table**, behind sign-in.
- Same key packages and dependencies as skills-upload, plus Ingage design system.
- Starters for both unit tests and E2E tests.

## Decisions made by Claude (open to correction)

- Lint/format stays **Biome** (matches skills-upload) rather than oxlint/oxfmt.
- DB access via **Drizzle ORM** + `drizzle-kit` migrations (SQL files checked in), node-postgres
  driver.
- Sample table is a generic **`notes`** table: `id`, `title`, `created_by` (signed-in email),
  `created_at`.
- **Migrations run automatically at container startup**, before the server accepts traffic.
- **Postgres auth in Azure uses Entra / managed identity** (no DB password). Locally, a
  password-based Postgres from `docker compose`.
- **Postgres networking:** public access restricted to Azure services (firewall rule
  `0.0.0.0`) plus the developer's IP when needed. VNet integration is future work.
- **One Azure Container Registry per resource group** (keeps dev/prod independent). Prod
  receives the exact image built for dev without rebuilding and without any cross-environment
  role assignment: the build job saves the image as a workflow artifact (`docker save`), and the
  prod job loads it and pushes it to the prod ACR using only the prod identity.
- **Secrets in Key Vault**, referenced by the Container App through a user-assigned managed
  identity.
- **One user-assigned managed identity per environment** used for ACR pull, Key Vault read, and
  Postgres login.
- **One Entra app registration per environment** for user sign-in (separate redirect URIs and
  secrets), and a separate Entra app (or federated credential) per environment for GitHub
  Actions OIDC deploy.
- **CI/CD:** push to `main` → build, push to dev ACR, deploy dev. Prod deploy is a job gated by
  a GitHub `prod` environment with required reviewers.
- **Application Insights** (workspace-based) per environment, plus Log Analytics for Container
  Apps logs. The app is instrumented with `@azure/monitor-opentelemetry` (registered in
  `instrumentation.ts`), enabled only when `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, so
  local dev and CI send nothing.
- `/api/health` endpoint used by Container Apps probes; it does **not** require sign-in.
- Default region `eastus2` (matches skills-upload), as a placeholder variable.
- Node 22, pnpm, exact version pins, Dependabot with 7-day cooldown and grouped updates, GitHub
  Actions pinned to commit SHAs with version comments.

## The application

### Stack (mirrors skills-upload)

Runtime and framework: Node 22, pnpm (via `packageManager`), Next.js 16 App Router, React 19,
TypeScript 5.9 (strict). Auth: Auth.js / `next-auth` v5 with the Microsoft Entra ID provider.
UI: `@ingagegroup/ingage-react`, `@ingagegroup/ingage-design-tokens`, Tailwind CSS 4 (layout
only). Validation: Zod. Data: `drizzle-orm`, `drizzle-kit`, `pg`; `@azure/identity` for the
Postgres Entra token. Telemetry: `@azure/monitor-opentelemetry`. Tests: Vitest + `@vitest/coverage-v8`, Playwright. Lint/format: Biome.
`dotenv` for Playwright env.

Versions: start from skills-upload's pinned versions; look up current stable for anything new
(Drizzle, `pg`, `@azure/identity`) at build time. Pin exactly (no `^`/`~`).

`.npmrc` points `@ingagegroup` at GitHub Packages using `${NODE_AUTH_TOKEN}` (same as
skills-upload).

### Behavior

- **Everything requires sign-in** except: `/auth/signin`, `/api/auth/*`, `/api/health`,
  Next static assets, favicon/icon, and `/assets/logos/`.
- `src/proxy.ts`: same fail-closed gate as skills-upload — unauthenticated page requests
  redirect to `/auth/signin?callbackUrl=…`, unauthenticated API requests get 401, any auth
  resolution error denies.
- `ALLOWED_EMAIL_DOMAIN` (default `ingagepartners.com`) restricts sign-in, case-insensitive.
- `E2E_AUTH_BYPASS=true` skips auth **only when `NODE_ENV !== "production"`**. In bypass mode
  the current user is a fixed test identity (e.g. `e2e@example.com`) so `created_by` works.
- **Sign-in page** (`/auth/signin`): Ingage branding, "Sign in with Microsoft" button. No
  AppShell.
- **Welcome page** (`/`): inside `AppShell` + `AppHeader` (app name, signed-in user, sign out) +
  `Sidebar` (one item: Welcome). Content: a short welcome explaining what the template gives
  you and pointing to the README; below it the **Notes** sample — a table of rows (title,
  created by, created at, newest first), an empty state when there are none, and a small form
  to add a note.
- **API:** `GET /api/notes` (list), `POST /api/notes` (create; Zod-validated body, `title`
  trimmed, 1–200 chars; `created_by` from the session, never from the body). Errors return JSON
  with a clear message and correct status (400 validation, 401 unauthenticated, 500 DB failure
  logged with context).
- **`GET /api/health`:** returns 200 `{ status: "ok" }` when the app is up and can reach the
  database, 503 otherwise. Unauthenticated.
- Security headers and CSP as in skills-upload's `next.config.ts`; `output: "standalone"`.
- Design system rules from skills-upload's CLAUDE.md apply (tokens for color/type, Tailwind for
  layout only, one orange accent per section, title-case CTAs, no emoji) and the known library
  gotchas (e.g. `Button` has no `type`, so the add-note form must not be submitted accidentally).

### Database

- Drizzle schema in `src/db/schema.ts`; migrations generated into `drizzle/` and committed.
- One DB module (`src/db/index.ts`) creates the pool. Connection mode:
  - **Local / CI:** `DATABASE_URL` with password (docker compose / CI service container).
  - **Azure:** host, database, and user from env vars (`PGHOST`, `PGDATABASE`, `PGUSER`) and the
    password supplied per-connection as an Entra access token for
    `https://ossrdbms-aad.database.windows.net/.default`, obtained with the managed identity
    (`AZURE_CLIENT_ID` of the user-assigned identity). Tokens expire, so the pool must fetch a
    fresh token per new connection, not once at startup.
- Migrations run at container start (e.g. an entrypoint step or Next.js `instrumentation.ts`)
  using the same connection logic; the `drizzle/` folder must be copied into the standalone
  image. If migration fails, the container exits non-zero with a clear log line.
- `docker-compose.yml` provides Postgres for local dev; `pnpm db:generate`, `pnpm db:migrate`
  scripts.

### Tests

- **Unit (Vitest), colocated `*.test.ts`:** email-domain check, auth-bypass guard (incl.
  production can't bypass), proxy gate decisions (public paths, 401 vs redirect, fail closed),
  notes Zod schema (empty, whitespace, too long, wrong types), notes route handlers with the DB
  module mocked (success, validation error, DB error), health route (ok and DB-down).
- **E2E (Playwright), `e2e/`:** with auth bypass and a real Postgres — Welcome page renders in
  the AppShell; empty state shows; adding a note makes it appear in the table; validation error
  for empty title; `/api/health` returns ok. A sign-in-page test with bypass off is not
  practical in CI; instead a unit test covers the redirect decision, and one E2E test loads
  `/auth/signin` directly and checks it renders.
- Projects: desktop Chrome and mobile Chrome (as skills-upload); CI runs desktop.
- Tests must pass on a fresh clone with no Azure credentials.

### Repo layout (outline)

```
.github/workflows/   lint-format.yml, unit-tests.yml, e2e-tests.yml, deploy.yml
.github/dependabot.yml
.githooks/pre-commit (biome check --staged)
docs/superpowers/specs/   this design
drizzle/             SQL migrations
e2e/                 Playwright specs
public/assets/logos/ copied from @ingagegroup/ingage-design-tokens
src/app/             layout, page (Welcome), auth/signin, api/auth, api/notes, api/health
src/components/      AppChrome, PageHeader, EmptyState (adapted from skills-upload)
src/db/              schema.ts, index.ts, migrate.ts
src/lib/             auth.ts, e2e-bypass.ts, validation.ts
src/proxy.ts
.env.local.example, .env.test, .npmrc, Dockerfile, .dockerignore, docker-compose.yml,
biome.json, next.config.ts, playwright.config.ts, vitest.config.mts, drizzle.config.ts,
tsconfig.json, package.json, README.md, CLAUDE.md, AGENTS.md
```

## Azure (per app, per environment)

Resource group: `rg-<APPNAME>-<ENV>` where `<ENV>` is `dev` or `prod`. Contents:

| Resource | Purpose |
|---|---|
| Log Analytics workspace | Container Apps logs, App Insights backing store |
| Application Insights (workspace-based) | Request tracing, errors |
| User-assigned managed identity | ACR pull, Key Vault read, Postgres login |
| Azure Container Registry (Basic) | App images |
| Key Vault (RBAC mode) | `auth-secret`, `entra-client-secret` |
| PostgreSQL Flexible Server | Burstable B1ms in dev, slightly larger in prod (placeholder SKU); Entra auth enabled; database `<APPNAME>` |
| Container Apps environment | Hosts the app, logs to Log Analytics |
| Container App | The Next.js image, port 3000, external ingress, health probes on `/api/health` |

Names must respect Azure rules (ACR alphanumeric and globally unique; Key Vault 3–24 chars,
globally unique; Postgres server globally unique). The README defines all names once as shell
variables derived from `APPNAME` and `ENV`, and states the constraints on `APPNAME` (lowercase
letters and digits, short enough for the Key Vault limit).

## README structure

1. **Start here: create your repo from this template** — step by step with the GitHub UI
   (**Use this template → Create a new repository**, owner IngageGroup, private) and the
   `gh repo create IngageGroup/<name> --template IngageGroup/bench-web-template --private` CLI
   equivalent. Then: grant the new repo Actions access to the two `@ingagegroup` packages
   (Package settings → Manage Actions access) — needed for CI installs.
2. **Get Azure access** — contact phil.lachmann@ingagepartners.com for Azure access for a new
   application (subscription/resource group permissions and Entra app registrations).
3. **Rename checklist** — every marked spot to change (app name in `package.json`, layout
   metadata, `AppChrome`, image name, `APPNAME` variables, domain/`AUTH_URL`). Placeholders use
   a single greppable form (e.g. `<APPNAME>`, `__APP_NAME__` in code) and the checklist says how
   to find them all.
4. **Local development** — prerequisites (Node 22, pnpm, Docker, `gh`), `NODE_AUTH_TOKEN`,
   `docker compose up -d`, `.env.local`, migrations, `pnpm dev`, auth bypass option.
5. **Commands** — dev, build, lint, format, test, test:e2e, db scripts.
6. **Testing** — what the starter tests cover and where to add new ones.
7. **Environment variables** — table, with placeholders.
8. **Provision Azure (az CLI)** — run once per environment with `ENV=dev` then `ENV=prod`:
   variables block with placeholders (`SUBSCRIPTION_ID`, `TENANT_ID`, `LOCATION`, `APPNAME`,
   `ENV`, derived names); then create, in order: resource group, Log Analytics, App Insights,
   managed identity, ACR + AcrPull role, Key Vault + Secrets User role, Postgres Flexible Server
   with Entra auth + firewall + database + Entra admin + create the managed identity as a DB
   role with the needed privileges, Container Apps environment, Container App (Key Vault secret
   references, registry via managed identity, env vars, probes). Each command is copy-pasteable
   and idempotent-ish where `az` allows.
9. **Entra app registration** — per environment: redirect URI
   `https://<host>/api/auth/callback/microsoft-entra-id` (and `http://localhost:3000/...` for
   dev), client secret into Key Vault, IDs as placeholders. Notes that Phil may create these.
10. **CI/CD** — GitHub environments `dev` and `prod` (prod with required reviewers), the OIDC
    federated credential setup with `az`, and the list of GitHub secrets/variables to set.
11. **Custom domain** — `az containerapp hostname add/bind` with managed certificate, and
    updating `AUTH_URL` and the Entra redirect URI.
12. **Logs & monitoring** — Kusto queries (`ContainerAppConsoleLogs`), App Insights.
13. **For template maintainers** — mark the repo as a template (Settings → Template
    repository).

## CI/CD

- `lint-format.yml`, `unit-tests.yml`, `e2e-tests.yml` on pull requests, as in skills-upload,
  with `NODE_AUTH_TOKEN: secrets.GITHUB_TOKEN` and `packages: read`. E2E job adds a Postgres
  service container and runs migrations before tests. Drop skills-upload's leftover dummy
  `ANTHROPIC_API_KEY`/`SERPAPI_API_KEY` env.
- `deploy.yml` on push to `main`: build image (Docker build secret for `NODE_AUTH_TOKEN`), tag
  with commit SHA, push to dev ACR, `az containerapp update` dev. Then a `prod` job in the
  `prod` GitHub environment (required reviewers) that `az acr import`s the same SHA into prod
  ACR and updates the prod Container App. Azure login via OIDC per environment.
- All actions pinned to full commit SHAs with version comments, `persist-credentials: false` on
  checkout, least-privilege `permissions`. Lint with `actionlint` and `zizmor`.
- `dependabot.yml`: npm (pnpm) and github-actions ecosystems, 7-day cooldown, grouped.

## Docs for agents

`CLAUDE.md` (and a short `AGENTS.md` pointing to it), modeled on skills-upload's: overview,
setup, stack, structure, commands, design-system rules and gotchas, key patterns (auth gate,
DB connection modes, migrations), env vars, conventions, gotchas (private registry token,
Vitest exclude of nested `node_modules`/`.claude`).

## Constraints

- No real secrets or IDs committed; `.env.local` gitignored; `.env.local.example` has
  placeholders only.
- Biome clean, `tsc --noEmit` clean, all tests passing, no warnings.
- `pnpm install` requires `NODE_AUTH_TOKEN` with `read:packages` (classic PAT).
- The directory is not yet a git repo; the builder initializes it. Publishing to IngageGroup
  and marking it as a template are the user's steps (documented in the README).

## Left to the builder

- Exact file and component structure within the outline above.
- Where migrations hook in (entrypoint script vs `instrumentation.ts`), as long as they run
  before traffic and fail loudly.
- Exact `az` flags, SKUs within the stated tiers, and probe timings.
- Welcome page copy and exact layout, within the design system rules.
- Placeholder token format, as long as it is consistent and greppable.
