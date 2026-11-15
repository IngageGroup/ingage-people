# CLAUDE.md

## Project Overview

Next.js app created from the Ingage **bench web template**. Signed-in users land on the chat
page (`/`) inside the Ingage AppShell; the template's Postgres-backed **Notes** sample is at
`/notes` until #18 removes it. Everything
except the sign-in page, the auth API, `/api/health`, and static assets requires Microsoft
Entra sign-in, restricted to `ALLOWED_EMAIL_DOMAIN`.

The Notes feature is the reference pattern for a database-backed feature: schema → query
module → Zod-validated route → client component → unit + E2E tests.

## Setup

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # read:packages, for @ingagegroup/*
pnpm install
docker compose up -d                      # Postgres on localhost:55432
cp .env.local.example .env.local          # or set E2E_AUTH_BYPASS=true to skip Entra
pnpm db:migrate
pnpm dev                                  # http://localhost:3000
```

The README covers Azure provisioning, CI/CD, and renaming.

## Tech Stack

- **Framework:** Next.js 16 (App Router), React 19, TypeScript 5.9 (strict)
- **Auth:** next-auth v5 (beta) with the Microsoft Entra ID provider
- **Data:** Drizzle ORM + drizzle-kit migrations, node-postgres; `@azure/identity` for the
  Postgres Entra token in Azure
- **Validation:** Zod
- **Design system:** `@ingagegroup/ingage-react` + `@ingagegroup/ingage-design-tokens` (light only)
- **Styling:** Tailwind CSS 4 for layout only; colors and type from Ingage tokens
- **Telemetry:** `@azure/monitor-opentelemetry`, enabled only when
  `APPLICATIONINSIGHTS_CONNECTION_STRING` is set
- **Lint/format:** Biome. **Tests:** Vitest (unit), Playwright (E2E). **Packages:** pnpm

## Project Structure

```
src/
├── app/
│   ├── api/auth/[...nextauth]/route.ts  # Auth.js handlers
│   ├── api/notes/route.ts               # GET list, POST create (Zod, created_by from session)
│   ├── api/health/route.ts              # DB ping with 5 s cap; public; used by probes
│   ├── auth/signin/page.tsx             # Sign-in card (no AppShell)
│   ├── layout.tsx                       # Token CSS + SessionProvider + AppChrome
│   ├── page.tsx                         # Chat page (/)
│   ├── ChatPanel.tsx                    # Chat state, /api/chat streaming, empty/error states (client)
│   └── notes/                           # Notes sample at /notes (removed in #18)
├── components/                          # AppChrome, PageHeader, EmptyState, CitationList
├── db/
│   ├── schema.ts                        # Drizzle tables
│   ├── config.ts                        # Connection mode selection + Entra token provider
│   ├── index.ts                         # Lazy pool/db, pingDb
│   ├── notes.ts                         # Notes queries
│   └── migrate.ts                       # runMigrations() under an advisory lock
├── lib/
│   ├── app-config.ts                    # APP_NAME / APP_DESCRIPTION (rename here)
│   ├── chat-protocol.ts                 # /api/chat NDJSON events (Zod) + readChatStream
│   ├── chat-history.ts                  # Earlier turns sent with follow-up questions
│   ├── chat-topics.ts                   # Topics + example questions for the empty state
│   ├── auth.ts                          # NextAuth config, isAllowedEmail, getCurrentUserEmail
│   ├── e2e-bypass.ts                    # isAuthBypassed, E2E_USER_EMAIL
│   └── validation.ts                    # Zod schemas for API input
├── instrumentation.ts                   # register() → instrumentation-node (Node runtime only)
├── instrumentation-node.ts              # Telemetry, then migrations in production
└── proxy.ts                             # Auth gate (Next 16 replaces middleware.ts)
drizzle/                                 # Generated SQL migrations (committed)
e2e/                                     # Playwright specs, db reset helper, warm-up
```

## Commands

```bash
pnpm dev             # Dev server
pnpm build           # Production build
pnpm lint            # Biome lint + format check (src, e2e, root configs)
pnpm lint:fix        # Biome auto-fix
pnpm format:check    # Biome format check
pnpm typecheck       # tsc --noEmit
pnpm test            # Vitest
pnpm test:e2e        # Playwright (needs docker compose Postgres + migrations)
pnpm db:generate     # New migration from src/db/schema.ts
pnpm db:migrate      # Apply migrations to DATABASE_URL
```

## Design System & Styling

Use the Ingage components before writing custom markup.

- **Shell:** `AppChrome` renders `AppShell` + `AppHeader` + `Sidebar` and skips them on
  `/auth/*`. Sidebar item ids are route paths; selecting one calls `router.push`.
- **Logos:** copied from the tokens package to `public/assets/logos/`, passed as
  `logoBasePath="/assets/logos"`. That path is public in `proxy.ts` so the sign-in page can
  show it.
- **Tokens:** apply colors and type with `style={{ color: "var(--text-muted)" }}`, not
  Tailwind color classes. Tailwind is for layout, spacing, and breakpoints.
- **Brand rules:** light theme only; one orange accent (primary `Button`) per section; CTA
  labels in title case; no emoji.

**Library gotchas (ingage-react 0.1.1):**
- `Button`, `Tabs`, and `LeftMenuItem` render `<button>` without `type`, so inside a `<form>`
  they submit it. `NotesPanel` uses no `<form>`; Enter in the input triggers the add instead.
- `Input` only links its `<label>` to the field when you pass `id` (use `useId()`).
- `AppHeader` hides the app name on narrow screens.
- `TableListHeading`/`TableListLine` are CSS grids, not `<table>`; pass the same column
  widths to both.

## Key Patterns

- **Auth gate (`src/proxy.ts`):** fails closed. Unauthenticated pages redirect to
  `/auth/signin?callbackUrl=…`, unauthenticated APIs get 401, and auth errors deny. Auth.js
  error objects don't count as sessions. Public paths match on whole path segments
  (`/api/auth` covers `/api/auth/session`, not `/api/authors`). Add public paths to
  `PUBLIC_PATHS` only deliberately.
- **Current user:** routes call `getCurrentUserEmail()`. It returns `e2e@example.com` under
  bypass and `null` when signed out, and routes return 401 on `null`. Never take user
  identity from the request body.
- **Auth bypass:** `E2E_AUTH_BYPASS=true` works only when `NODE_ENV !== "production"`.
- **DB connection modes (`src/db/config.ts`):** `DATABASE_URL` (local/CI) or
  `PGHOST`/`PGDATABASE`/`PGUSER` (Azure). In Azure the password is a function, so `pg`
  fetches a fresh Entra token for every new connection. Nothing connects at import time.
- **Migrations:** `pnpm db:generate` writes SQL to `drizzle/`; commit it. In production,
  `instrumentation-node.ts` runs `runMigrations()` before the server takes traffic, holding
  a Postgres advisory lock so replicas don't race. On failure it logs
  `[migrate] failed; exiting` and exits 1. The Dockerfile copies `drizzle/` into the image.
- **Chat wire format (`src/lib/chat-protocol.ts`):** `/api/chat` streams NDJSON events
  (`delta`, `citation`, then one `done`, or one `error`). Failures before streaming are plain
  JSON `{ error, correlationId }`. The UI keeps the conversation in React state only (no
  `localStorage`) and sends at most `CHAT_HISTORY_MAX_TURNS` earlier turns.
- **Errors:** route DB failures log `[api/<route> <correlationId>] <operation> failed` and
  return `{ error, correlationId }` with status 500. Validation failures return 400 with the
  first Zod message.

## Environment Variables

See the README's table and `.env.local.example`. Required locally: `DATABASE_URL`, plus
either the `AZURE_AD_*` trio + `AUTH_SECRET` or `E2E_AUTH_BYPASS=true`.

## Code Conventions

- `"use client"` on any component that uses hooks or browser APIs.
- Absolute imports through `@/*` → `./src/*`.
- Auth is enforced in `src/proxy.ts`, and routes that need the user also check
  `getCurrentUserEmail()`.
- All API input goes through Zod schemas in `src/lib/validation.ts`.
- Unit tests are colocated `*.test.ts`; mock only boundaries (DB modules, Auth.js, Azure SDK).
- Exact dependency versions only (no `^`/`~`); `pnpm-workspace.yaml` enforces a 24 h
  minimum release age.

## Gotchas

- **Private registry needs a token:** `pnpm install` returns 404 for `@ingagegroup/*`
  without `NODE_AUTH_TOKEN`. CI passes `secrets.GITHUB_TOKEN` (`packages: read`); the Docker
  build takes it as the `node_auth_token` build secret. Each package must grant the repo
  Actions access.
- **Vitest must exclude nested checkouts:** `vitest.config.mts` excludes
  `**/node_modules/**` and `**/.claude/**`. Overriding `exclude` without them makes Vitest
  scan agent worktrees.
- **Port 55432:** compose maps Postgres to 55432 so it doesn't clash with a local Postgres
  on 5432.
- **E2E runs one test at a time** (shared database). The first test after a cold `next dev`
  start used to flake while routes compiled; `e2e/global-setup.ts` warms them up first.
- **E2E needs `next dev`:** `next start` sets `NODE_ENV=production`, which turns the auth
  bypass off by design.
