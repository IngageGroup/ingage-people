# CLAUDE.md

## Project Overview

Ingage People: an internal chat where employees ask about working at Ingage and get answers
from the Employee Handbook with citations. Signed-in users land on the chat page (`/`) inside
the Ingage AppShell. Everything except the sign-in page, the auth API, `/api/health`, and
static assets requires Microsoft Entra sign-in, restricted to `ALLOWED_EMAIL_DOMAIN`.

The app started from the Ingage bench web template. Design:
`docs/superpowers/specs/2026-11-12-internal-knowledge-chat-design.md`.

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
│   ├── api/health/route.ts              # DB ping with 5 s cap; public; used by probes
│   ├── api/chat/route.ts                # POST: passages → Claude → NDJSON stream
│   ├── auth/signin/page.tsx             # Sign-in card (no AppShell)
│   ├── layout.tsx                       # Token CSS + SessionProvider + AppChrome
│   ├── page.tsx                         # Chat page (/)
│   └── ChatPanel.tsx                    # Chat state, /api/chat streaming, empty/error states (client)
├── components/                          # AppChrome, PageHeader, EmptyState, CitationList
├── db/
│   ├── schema.ts                        # Drizzle tables
│   ├── config.ts                        # Connection mode selection + Entra token provider
│   ├── index.ts                         # Lazy pool/db, pingDb
│   ├── knowledge.ts                     # Knowledge sources: atomic version swap, active version
│   ├── search.ts                        # keywordSearch (FTS) + vectorSearch (pgvector) per topic
│   ├── rate-limit.ts                    # Per-user chat quota (chat_usage counters)
│   ├── chat-stats.ts                    # Daily answer counts by topic/outcome and cited section
│   └── migrate.ts                       # runMigrations() under an advisory lock
├── lib/
│   ├── app-config.ts                    # APP_NAME / APP_DESCRIPTION / HR_CONTACT
│   ├── chat/answer.ts                   # streamAnswer: Claude tool loop, [id] markers → citations
│   ├── chat/markers.ts                  # Strips [p1]/[f1]/[m1]/[t1] markers from the stream, even split
│   ├── chat/tools.ts                    # search_handbook + read-only Microsoft 365 tools
│   ├── chat/sources.ts                  # SourceRegistry: per-answer ids → citations and sources
│   ├── chat/passages.ts                 # Passage type, PassageProvider (retrieve → re-rank)
│   ├── chat-protocol.ts                 # /api/chat NDJSON events (Zod) + readChatStream
│   ├── chat-history.ts                  # Earlier turns sent with follow-up questions
│   ├── chat-topics.ts                   # Topics and examples; work topic only with M365_TOOLS
│   ├── chat/topic-check.ts              # Haiku classifier: topic id or off-topic
│   ├── auth.ts                          # NextAuth config, isAllowedEmail, getCurrentUserEmail
│   ├── graph-token.ts                   # Graph scopes, token refresh, getGraphAccessToken
│   ├── graph/                           # Graph client (retries, safe errors), files, mail, Teams
│   ├── e2e-bypass.ts                    # isAuthBypassed, E2E_USER_EMAIL
│   └── validation.ts                    # Zod schemas for API input
├── knowledge/                           # Ingest pipeline (`pnpm ingest`)
│   ├── sources.ts                       # Source config (reviewed in PRs)
│   ├── fetch.ts                         # Per-kind fetch: change marker + lazy parse
│   ├── markdown.ts, document.ts         # Parsers produce ParsedDocument (sections)
│   ├── pdf.ts, pdf-layout.ts            # pdf.js text → sections: font-size headings, tables, pages
│   ├── chunk.ts                         # Heading-bound chunks, 2000-char cap, 200 overlap
│   ├── voyage.ts                        # Voyage document embeddings, batched, retried
│   ├── ingest.ts                        # fetch → skip if unchanged → chunk → embed → swap
│   ├── retrieve.ts, rrf.ts              # Hybrid search merged by reciprocal rank fusion
│   ├── select.ts                        # Voyage re-rank, top 5, relevance threshold
│   └── cli.ts                           # `pnpm ingest [--source <id>] [--force]`
├── eval/                                # `pnpm eval`: cases, metrics, Claude judge, generator
├── instrumentation.ts                   # register() → instrumentation-node (Node runtime only)
├── instrumentation-node.ts              # Telemetry, then migrations in production
└── proxy.ts                             # Auth gate (Next 16 replaces middleware.ts)
docs/knowledge/                          # Markdown the chat answers from (repo-markdown sources)
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
pnpm test            # Vitest (no database)
pnpm ingest          # Ingest knowledge sources (needs VOYAGE_API_KEY, HANDBOOK_LOCAL_PATH)
pnpm eval            # Handbook eval against local ingested data (costs money; run manually)
pnpm eval:generate <handbook> --out <file>  # Draft new eval cases with Claude, for review
pnpm test:db         # *.db.test.ts against the docker compose Postgres (migrate first)
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
  they submit it. `ChatPanel` uses no `<form>`; Enter in the textarea sends instead.
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
- **Graph token (`src/lib/graph-token.ts`):** sign-in requests `GRAPH_SCOPES` (delegated,
  read-only, plus `offline_access`). The `jwt` callback keeps access token, refresh token and
  expiry in the encrypted session cookie and refreshes 5 min before expiry; a failed refresh,
  or a session without Graph tokens, returns null and ends the session. The `session`
  callback never copies the tokens, so they don't reach the browser. Server code calls
  `getGraphAccessToken()`, which reads the cookie with `getToken` and refreshes again if
  needed (the proxy's refreshed cookie only lands on the response). It throws
  `GraphTokenError` with `reason` `unavailable` (auth bypass), `signed-out`, or
  `refresh-failed`. Never log or return the token.
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
- **Chat answers (`src/lib/chat/`):** after the topic check, `streamAnswer` runs Claude
  (`CHAT_MODEL`, default `claude-haiku-5-5`; cached system prompt) through the SDK tool runner
  (`stream: true`, `max_iterations: 8`) with `chatTools()`. Each passage or item a tool
  returns is registered in a per-request `SourceRegistry` as `p1…`/`f1…`/`m1…`/`t1…`; Claude
  cites `[id]`, the markers are stripped from the stream, and registered ids become
  `citation` events (unknown ids are ignored). An answer citing none is `dont-know`; a run
  that ends on `tool_use` or `max_tokens` is the cut-off error. Never log question, answer,
  or tool-result text.
- **Topic check (`src/lib/chat/topic-check.ts`):** first, Claude Haiku (`CHAT_TOPIC_MODEL`,
  no thinking, effort low, structured output) classifies the question, with the last two
  turns for follow-ups, into a `chatTopics()` id or `off-topic`. Off-topic (or a refusal)
  gets `offTopicAnswer()` with outcome `off-topic`; no answer call. If the check fails, the
  route logs it and answers anyway with every knowledge topic (`searchTopics`). Adds about
  1 s per question.
- **Chat tools (`src/lib/chat/tools.ts`):** `search_handbook` wraps the passage provider
  (`src/lib/chat/passages.ts` → `src/knowledge/select.ts`): retrieve over the knowledge
  topic the check picked, re-rank with Voyage (`VOYAGE_RERANK_MODEL`, default `rerank-3`),
  keep the top 5 scoring at least `SELECT_CONFIG.minScore` (0.55, set from the eval); none
  above it → "No handbook passages matched." With `M365_TOOLS=enabled` (dev only until #2),
  six read-only Graph tools search and read the user's files, mail, and Teams with
  `getGraphAccessToken()`; the work topic, its example, and the UI copy follow the same
  setting (`m365Enabled()`, read on the server). Tool failures are logged with
  `describeError` and returned to Claude as `ToolError` messages, never raw error text.
  Locally the chat only knows what you've ingested: `pnpm ingest --source handbook`.
- **Graph (`src/lib/graph/`):** `graphRequest` retries 429/5xx up to 3 times, honours
  `Retry-After` up to 5 s, and throws `GraphError` with method, path (no query), status,
  and Graph's error code only. Searches use `POST /search/query` so search text never lands
  in a URL (HTTP telemetry records URLs). Office files are read as `?format=pdf` through
  `parsePdf`; any tool text is capped at `TOOL_TEXT_MAX` (20 000 chars).
- **Knowledge store (`src/db/knowledge.ts`):** sources → versions → chunks.
  `replaceSourceContent` writes a new version's chunks, switches the source's
  `active_version_id`, and deletes the old chunks in one transaction; on failure the old
  version stays active and a `failed` version row is recorded. Embeddings are
  `vector(1024)` (Voyage 4 default; HNSW, cosine). `search` is a generated `tsvector` over
  `section_path` (jsonb, weight A) and `text` (weight B); `section_path` is jsonb because
  `to_tsvector(regconfig, jsonb)` is immutable and `array_to_string` isn't.
- **Ingest (`src/knowledge/`):** a source kind supplies a change marker cheaply and a lazy
  `load()`; unchanged sources are skipped unless `--force`. Chunks never span sections.
  A `repo-markdown` source is a folder under `docs/knowledge/` (copied into the image): each
  `.md` file is its own source `<id>/<path>` with a content hash, cited as
  `/docs/<id>/<path>`; deleted files' sources are removed, and a missing or empty folder fails
  instead of deleting everything. A topic goes into `CHAT_TOPICS` only once its docs exist.
  Embeddings use the text prefixed with `title > heading path`. Logs carry source id, version,
  chunk count, and timings, never document text. `pnpm ingest` runs through `tsx` with
  `--env-file-if-exists=.env.local`; the production image doesn't include it yet (#9).
- **PDF parsing (`src/knowledge/pdf-layout.ts`):** pdf.js gives positioned text; lines larger
  than the body size are headings (nested by size; runs of 3+ lines are text), aligned columns
  become Markdown tables (wrapped cells merged, continued across pages), bullets become `- `
  lists, page numbers and repeated headers/footers are dropped, and pages before the first
  bookmark are skipped. A section's `page` is where it starts. The chunker splits long tables
  between rows and repeats the header. Fixtures come from `makePdf` (`pdf-fixture.ts`), never
  the real handbook.
- **Retrieval (`src/knowledge/retrieve.ts`):** keyword (`websearch_to_tsquery` +
  `ts_rank_cd`) and vector (cosine, Voyage `query` embedding) searches run in parallel over
  the given topics' active chunks, ~30 each (`RETRIEVAL_CONFIG`), merged by RRF (k = 60). Keyword
  ranking lives only in `keywordSearch` so it can become BM25. `vectorSearch` sets
  `hnsw.iterative_scan = relaxed_order` so the topic filter can't starve the HNSW results.
- **Rate limits (`src/db/rate-limit.ts`):** after auth and validation, `/api/chat` calls
  `consumeChatQuota(email)`: 10 questions per minute and 100 per UTC day
  (`CHAT_RATE_LIMITS`), fixed windows in `chat_usage` (counters only). Increments happen in a
  transaction that rolls back when over a limit, so refused questions don't count. Over →
  429 with `Retry-After` and a message the UI shows. Quota check failure → 500.
- **Outcome counts (`src/db/chat-stats.ts`):** after each streamed reply (and on a search
  failure) the route calls `recordChatOutcome({ topic, outcome, citedSections })`, which bumps
  `chat_outcome_counts` and, for answers, `chat_citation_counts` (each section once). Counters
  only: no text, no email. A failed count is logged and never changes the reply. Queries:
  README 10.2.
- **Chat privacy:** never log question, answer, or passage text. `/api/chat` logs
  `describeError(err)` (`src/lib/safe-error.ts`): name plus status/type/code/SQLSTATE/request
  id; upstream messages are dropped. Throw `SafeError` when the message helps operators and
  holds no user content. Create Claude clients for chat with `chatClient()` (log level pinned
  to "warn"). Azure Monitor options live in `src/lib/telemetry.ts` (no Postgres parameter
  values, no console capture). Manual check: README 10.1.
- **Eval (`src/eval/`, `evals/handbook.jsonl`, `evals/m365.jsonl`):** `pnpm eval` runs every
  case through the chat's own steps (`checkTopic`, `chatSearch` + `selectPassages`, the agent
  in `streamAnswer`), judges
  answers with Claude (`EVAL_JUDGE_MODEL`) against the expected facts and the passages, and
  prints retrieval hit rates, answer grades, don't-know precision/recall, topic-check and
  injection results, and a threshold sweep. It calls Claude and Voyage (costs money), so it
  runs by hand, not in CI. Cases carry short facts, not handbook text. Re-run it before
  changing prompts, chunking, models, or thresholds. `pnpm eval --cases evals/m365.jsonl`
  turns the Microsoft 365 tools on against made-up Graph data (`src/eval/m365-fixtures.ts`).
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
- **Database tests are separate:** `*.db.test.ts` need Postgres, so `vitest.config.mts`
  excludes them and `vitest.db.config.mts` runs only them (one file at a time). CI runs them
  in the unit-tests job against a pgvector service. Mock-based tests can't catch a missing
  transaction; keep swap behaviour tested against real Postgres.
- **Port 55432:** compose maps Postgres to 55432 so it doesn't clash with a local Postgres
  on 5432.
- **E2E runs one test at a time** (shared database). The first test after a cold `next dev`
  start used to flake while routes compiled; `e2e/global-setup.ts` warms them up first.
- **E2E needs `next dev`:** `next start` sets `NODE_ENV=production`, which turns the auth
  bypass off by design.
