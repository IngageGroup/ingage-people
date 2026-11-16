# Ingage People

Internal chat where Ingage employees ask questions about working at Ingage and get answers
from the Employee Handbook, with citations. A Next.js app with Microsoft Entra sign-in, the
Ingage design system, Postgres (pgvector) through Drizzle, Claude for answers, Voyage for
embeddings and re-ranking, and CI/CD to Azure Container Apps with separate dev and prod
environments.

Signed-in users land on the chat page. Questions go through a topic check, hybrid search
over the ingested handbook, re-ranking, and a Claude answer that cites its passages. The
design is in `docs/superpowers/specs/2026-11-12-internal-knowledge-chat-design.md`.

## Contents

1. [Get Azure access](#1-get-azure-access)
2. [Local development](#2-local-development)
3. [Commands](#3-commands)
4. [Testing](#4-testing)
5. [Environment variables](#5-environment-variables)
6. [Provision Azure (az CLI)](#6-provision-azure-az-cli)
7. [Entra app registration](#7-entra-app-registration)
8. [CI/CD](#8-cicd)
9. [Custom domain](#9-custom-domain)
10. [Logs & monitoring](#10-logs--monitoring)

---

## 1. Get Azure access

The app has two resource groups, `rg-ingagepeople-dev` and `rg-ingagepeople-prod`, with
nothing shared between them. For access, email **phil.lachmann@ingagepartners.com** with who
needs it. You'll get permissions on the subscription and resource groups, and on the Entra
app registrations (section 7).

## 2. Local development

**Prerequisites:** Node 22, pnpm (`corepack enable` picks the version from `package.json`),
Docker, and the GitHub CLI (`gh`).

```bash
# 1. Token for the private @ingagegroup packages (needs the read:packages scope).
gh auth refresh -s read:packages      # once
export NODE_AUTH_TOKEN=$(gh auth token)

# 2. Install
pnpm install

# 3. Local Postgres on localhost:55432 (55432, not 5432, so it won't clash with a local install)
docker compose up -d

# 4. Environment
cp .env.local.example .env.local
#    Fill in the Entra values (section 7) and AUTH_SECRET,
#    or uncomment E2E_AUTH_BYPASS=true to skip sign-in locally.

# 5. Create the tables
pnpm db:migrate

# 6. Run
pnpm dev                              # http://localhost:3000
```

`NODE_AUTH_TOKEN` must be set in any shell that runs `pnpm`. Otherwise installs return 404
for `@ingagegroup/*`, and pnpm warns that it can't read `.npmrc`.

**Auth bypass.** `E2E_AUTH_BYPASS=true` signs you in as `e2e@example.com` without Entra. It
only works when `NODE_ENV` is not `production`, so it can't switch on in a deployed app.

**Postgres image.** Compose and CI use `pgvector/pgvector` (Postgres 17, matching Azure)
so migrations can enable the `vector` extension. If your `postgres-data` volume was created
by the older `postgres:*-alpine` image, recreate it with `docker compose down -v` (this
deletes local data), then `docker compose up -d` and `pnpm db:migrate`.

**Changing the schema.** Edit `src/db/schema.ts`, run `pnpm db:generate` to write a new SQL
migration into `drizzle/`, review it, and commit it. Deployed containers apply pending
migrations at startup (section 6.10).

## 3. Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on http://localhost:3000 |
| `pnpm build` / `pnpm start` | Production build / serve it |
| `pnpm lint` / `pnpm lint:fix` | Biome lint + format check / auto-fix |
| `pnpm format` / `pnpm format:check` | Biome format write / check |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test` / `pnpm test:watch` | Vitest unit tests |
| `pnpm ingest [--source <id>] [--force]` | Bring knowledge sources up to date: fetch, skip if unchanged, chunk, embed with Voyage, swap in. `--force` re-ingests unchanged sources |
| `pnpm eval [--only <id,id>]` | Run the handbook eval (`evals/handbook.jsonl`) against the local knowledge store: retrieval hits, judged answers, don't-know and off-topic accuracy, injection cases, threshold sweep. Calls Claude and Voyage, so it costs money; run it by hand before changing prompts, chunking, models, or thresholds |
| `pnpm eval:generate <handbook> --out <file>` | Draft eval cases from a handbook copy with Claude. Review every case before adding it to `evals/handbook.jsonl` |
| `pnpm test:db` | Database tests (`*.db.test.ts`) against the docker compose Postgres; run `pnpm db:migrate` first |
| `pnpm test:e2e` | Playwright E2E (starts `pnpm dev` with auth bypass) |
| `pnpm test:e2e:ui` / `pnpm test:e2e:headed` | Playwright UI mode / visible browser |
| `pnpm db:generate` | Generate a SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |

A pre-commit hook (`.githooks/pre-commit`, installed by `pnpm install`) runs Biome on staged
files.

## 4. Testing

**Unit tests (Vitest)** sit next to the code they test as `*.test.ts`. The starters cover:

- the email-domain check and the auth-bypass guard, including that production can't bypass
  (`src/lib/*.test.ts`)
- the auth gate in `src/proxy.ts`: which paths are public, 401 for APIs vs. a redirect for
  pages, and failing closed on auth errors
- the chat request schema and the chat and health route handlers (with their boundaries
  mocked), DB connection-mode selection, the migration lock, and the startup hook
- the chat pipeline: topic check, retrieval and RRF, re-ranking and the threshold, citation
  markers, Voyage retries, and the ingest chunker and parsers

**Database tests** (`*.db.test.ts`, `pnpm test:db`) run against the docker compose
Postgres: the knowledge version swap, keyword and vector search, and the chat rate limit.

**E2E tests (Playwright)** live in `e2e/`. They run against `pnpm dev` with auth bypass and
the real local Postgres, one at a time. They cover the chat page in the AppShell, asking a
question and its states, the sign-in page, and `/api/health`.

```bash
docker compose up -d && pnpm db:migrate
pnpm test:e2e                          # desktop + mobile Chrome
pnpm test:e2e --project=desktop-chrome # what CI runs
```

Add unit tests for new logic next to it. Add one E2E test per user-visible flow.

## 5. Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `DATABASE_URL` | local, CI | Postgres URL with password (`postgres://app:app@localhost:55432/app`) |
| `PGHOST`, `PGDATABASE`, `PGUSER` | Azure | Postgres server, database, and role (the managed identity's name); password is an Entra token |
| `AZURE_CLIENT_ID` | Azure | Client ID of the user-assigned managed identity that gets the Postgres token |
| `AZURE_AD_CLIENT_ID` | all | Entra app registration (sign-in) client ID |
| `AZURE_AD_CLIENT_SECRET` | all | Entra client secret (Key Vault `entra-client-secret` in Azure) |
| `AZURE_AD_TENANT_ID` | all | Entra tenant ID |
| `AUTH_SECRET` | all | Auth.js session encryption key (Key Vault `auth-secret` in Azure) |
| `ANTHROPIC_API_KEY` | all | Claude API key; separate dev and prod keys (Key Vault `anthropic-api-key` in Azure) |
| `VOYAGE_API_KEY` | all | Voyage AI embeddings and re-rank key (Key Vault `voyage-api-key` in Azure) |
| `VOYAGE_EMBED_MODEL` | all | Voyage embedding model for ingest and search. Defaults to `voyage-4`; any Voyage 4 model works, stored at 1024 dimensions |
| `VOYAGE_RERANK_MODEL` | all | Voyage reranker for chat answers. Defaults to `rerank-3` |
| `HANDBOOK_LOCAL_PATH` | local | Downloaded copy of the handbook (`.pdf` or `.md`) for `pnpm ingest`; keep it outside the repo and never commit it |
| `CHAT_TOPIC_MODEL` | all | Claude model that checks each question's topic before search. Defaults to `claude-haiku-5-5` |
| `CHAT_MODEL` | all | Claude model for chat answers. Defaults to `claude-opus-5-5` |
| `AUTH_URL` | Azure | Public `https://` URL. Auth.js builds the OAuth callback from it |
| `ALLOWED_EMAIL_DOMAIN` | all | Only this email domain may sign in. Defaults to `ingagepartners.com` when unset or empty; `*` allows every account in the tenant |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Azure | Turns on Azure Monitor telemetry; unset means nothing is sent |
| `E2E_AUTH_BYPASS` | local, E2E | `true` skips sign-in outside production |

Set exactly one of `DATABASE_URL` or the three `PG*` variables. If neither is set, the app
fails with a message naming both options.

## 6. Provision Azure (az CLI)

Run this whole section once with `ENV=dev`, then again with `ENV=prod`. Each run creates a
fully separate set of resources:

| Resource | Purpose |
|---|---|
| Log Analytics workspace | Container Apps logs; backing store for App Insights |
| Application Insights | Request tracing and errors |
| User-assigned managed identity | Pulls from ACR, reads Key Vault, logs in to Postgres |
| Container Registry (Basic) | App images |
| Key Vault (RBAC) | `auth-secret`, `entra-client-secret`, `anthropic-api-key`, `voyage-api-key` |
| PostgreSQL Flexible Server | Entra auth only; database `<APPNAME>` |
| Container Apps environment | Hosts the app |
| Container App | The Next.js container, port 3000, health probes on `/api/health` |

You need the Azure CLI (`az login`), Docker, `psql`, `jq`, and `NODE_AUTH_TOKEN` exported
(section 2). Run everything in one bash or zsh session; later steps use variables set by
earlier ones. Steps 8.1–8.9 are safe to re-run: Azure `create` commands leave existing
resources as they are or update them in place, and steps that would replace a secret or add a
duplicate registration check for an existing one first. **Step 8.10 is first-time only.** It
creates the Container App from the `:initial` image, so re-running it after CI/CD has deployed
would roll the app back.

### 6.1 Variables

```bash
SUBSCRIPTION_ID=<SUBSCRIPTION_ID>
TENANT_ID=<TENANT_ID>
LOCATION=eastus2
APPNAME=ingagepeople      # 3–16 chars: lowercase letters and digits, starting with a letter
ENV=dev                   # dev | prod
REPO=ingage-people       # GitHub repo name under IngageGroup
IMAGE=ingage-people      # must match IMAGE_NAME in .github/workflows/deploy.yml

RG=rg-$APPNAME-$ENV
LAW=log-$APPNAME-$ENV
AI=appi-$APPNAME-$ENV
ID=id-$APPNAME-$ENV
ACR=acr${APPNAME}${ENV}   # alphanumeric only, globally unique
KV=kv-$APPNAME-$ENV       # ≤ 24 chars, globally unique
PG=pg-$APPNAME-$ENV       # globally unique
CAE=cae-$APPNAME-$ENV
APP=ca-$APPNAME-$ENV
PG_SKU=Standard_B1ms      # dev; use Standard_B2s (or larger) for prod

az account set --subscription "$SUBSCRIPTION_ID"
ME_ID=$(az ad signed-in-user show --query id -o tsv)
ME_UPN=$(az ad signed-in-user show --query userPrincipalName -o tsv)
```

`APPNAME` is limited to 16 characters because `kv-<APPNAME>-prod` must fit Key Vault's
24-character limit. ACR, Key Vault, and Postgres names are global across Azure. If a
`create` fails with "already taken", pick a more specific `APPNAME`. A deleted Key Vault is
soft-deleted for 90 days and keeps its name reserved: `az keyvault purge --name "$KV"`
frees it.

### 6.2 Resource group, logs, App Insights

```bash
az group create --name "$RG" --location "$LOCATION"

az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOCATION"
LAW_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)
LAW_CUSTOMER_ID=$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)
LAW_KEY=$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)

az extension add --name application-insights --upgrade
az monitor app-insights component create --app "$AI" -g "$RG" -l "$LOCATION" \
  --workspace "$LAW_ID" --application-type web
AI_CONNECTION=$(az monitor app-insights component show --app "$AI" -g "$RG" --query connectionString -o tsv)
```

### 6.3 Managed identity

```bash
az identity create -g "$RG" -n "$ID" -l "$LOCATION"
ID_RESOURCE_ID=$(az identity show -g "$RG" -n "$ID" --query id -o tsv)
ID_CLIENT_ID=$(az identity show -g "$RG" -n "$ID" --query clientId -o tsv)
ID_PRINCIPAL_ID=$(az identity show -g "$RG" -n "$ID" --query principalId -o tsv)
```

### 6.4 Container Registry

```bash
az acr create -g "$RG" -n "$ACR" -l "$LOCATION" --sku Basic --admin-enabled false
ACR_ID=$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)
az role assignment create --assignee-object-id "$ID_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal --role AcrPull --scope "$ACR_ID"
```

### 6.5 Key Vault

```bash
az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true
KV_ID=$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv)
KV_URI=$(az keyvault show -g "$RG" -n "$KV" --query properties.vaultUri -o tsv)

# The app's identity reads secrets; you write them.
az role assignment create --assignee-object-id "$ID_PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal --role "Key Vault Secrets User" --scope "$KV_ID"
az role assignment create --assignee-object-id "$ME_ID" \
  --assignee-principal-type User --role "Key Vault Secrets Officer" --scope "$KV_ID"

# Role assignments take a minute or two to apply. If this fails with Forbidden, wait and retry.
# Only created once: replacing auth-secret signs every user out.
az keyvault secret show --vault-name "$KV" --name auth-secret --output none 2>/dev/null ||
  az keyvault secret set --vault-name "$KV" --name auth-secret \
    --value "$(openssl rand -base64 32)" --output none

# API keys: use this environment's key (dev or prod). read -s keeps it out of shell history.
read -rs -p "Anthropic API key ($ENV): " KEY && echo
az keyvault secret set --vault-name "$KV" --name anthropic-api-key --value "$KEY" --output none
read -rs -p "Voyage API key ($ENV): " KEY && echo
az keyvault secret set --vault-name "$KV" --name voyage-api-key --value "$KEY" --output none
unset KEY
```

### 6.6 PostgreSQL Flexible Server

Entra authentication only (no password). You become the Entra admin. Public access is
limited to Azure services (`0.0.0.0`) plus, below, your own IP.

```bash
az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOCATION" \
  --tier Burstable --sku-name "$PG_SKU" --storage-size 32 --version 17 \
  --microsoft-entra-auth Enabled --password-auth Disabled \
  --admin-object-id "$ME_ID" --admin-display-name "$ME_UPN" --admin-type User \
  --public-access 0.0.0.0 --yes

az postgres flexible-server db create -g "$RG" --server-name "$PG" --name "$APPNAME"

# Allowlist pgvector. The app's migrations run CREATE EXTENSION vector at startup and fail
# until it is listed. azure.extensions is the whole list, so include anything else you use
# (e.g. --value VECTOR,PG_TRGM).
az postgres flexible-server parameter set -g "$RG" --server-name "$PG" \
  --name azure.extensions --value VECTOR

# Let your machine connect (needed for the next step; remove it afterwards if you like)
MY_IP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create -g "$RG" --server-name "$PG" \
  --name developer --start-ip-address "$MY_IP" --end-ip-address "$MY_IP"
```

Create the managed identity as a database role. Then let it create tables, because the app
runs its own migrations at startup. It isn't an admin, and pgvector isn't a trusted extension,
so you create `vector` here as the Entra admin. The app's migration then finds it already
installed and skips it. Without this step, startup fails with
`permission denied to create extension "vector"`.

**Existing servers** (created before pgvector): run the `azure.extensions` command above and
the `CREATE EXTENSION` line below before deploying the pgvector migration.

```bash
PGHOST="$PG.postgres.database.azure.com"
export PGPASSWORD=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)

psql "host=$PGHOST dbname=postgres user=$ME_UPN sslmode=require" -c \
  "SELECT * FROM pgaadauth_create_principal_with_oid('$ID', '$ID_PRINCIPAL_ID', 'service', false, false);"

psql "host=$PGHOST dbname=$APPNAME user=$ME_UPN sslmode=require" \
  -c "GRANT ALL ON DATABASE \"$APPNAME\" TO \"$ID\";" \
  -c "GRANT ALL ON SCHEMA public TO \"$ID\";" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"

unset PGPASSWORD
# Optional: az postgres flexible-server firewall-rule delete -g "$RG" --server-name "$PG" --name developer --yes
```

### 6.7 Sign-in app registration

Create the Entra app that users sign in through, and put its secret in Key Vault. If Phil is
creating registrations for you, skip the commands and set `APP_REG_ID` to the client ID he
gives you. He'll put the secret in Key Vault as `entra-client-secret`. Section 7 explains
redirect URIs.

```bash
APP_REG_ID=$(az ad app list --display-name "$APPNAME-$ENV" --query "[0].appId" -o tsv)
if [ -z "$APP_REG_ID" ]; then
  APP_REG_ID=$(az ad app create --display-name "$APPNAME-$ENV" \
    --sign-in-audience AzureADMyOrg --query appId -o tsv)
  az ad sp create --id "$APP_REG_ID" --output none
fi

az keyvault secret show --vault-name "$KV" --name entra-client-secret --output none 2>/dev/null ||
  az keyvault secret set --vault-name "$KV" --name entra-client-secret --output none --value \
    "$(az ad app credential reset --id "$APP_REG_ID" --append --display-name key-vault --years 1 \
      --query password -o tsv)"
```

The client secret expires after one year. To rotate it without a sign-in outage:

1. Add a new secret alongside the old one with `--append` and store it in Key Vault:
   `az keyvault secret set --vault-name "$KV" --name entra-client-secret --output none --value "$(az ad app credential reset --id "$APP_REG_ID" --append --display-name key-vault --years 1 --query password -o tsv)"`.
2. Restart the app so it reads the new value:
   `az containerapp revision restart -g "$RG" -n "$APP" --revision "$(az containerapp show -g "$RG" -n "$APP" --query properties.latestRevisionName -o tsv)"`.
3. Remove the old secret: find its `keyId` with `az ad app credential list --id "$APP_REG_ID"`,
   then run `az ad app credential delete --id "$APP_REG_ID" --key-id <KEY_ID>`.

#### Microsoft Graph permissions

The app reads Microsoft 365 as the signed-in user, with their own token, so it only sees
what that user can already open. The registration asks for these delegated, read-only Graph
permissions; nothing can send or change data.

| Permission | Lets the app read |
|---|---|
| `User.Read` | The user's profile (sign-in) |
| `offline_access` | A refresh token, so the session can renew the Graph token |
| `Files.Read.All` | Files the user can open in OneDrive and SharePoint |
| `Sites.Read.All` | SharePoint sites and lists the user can open |
| `Mail.Read` | The user's mailbox |
| `Chat.Read` | The user's Teams chats |
| `ChannelMessage.Read.All` | Messages in Teams channels the user belongs to |
| `Team.ReadBasic.All` | Names of the teams the user belongs to |

```bash
GRAPH=00000003-0000-0000-c000-000000000000
PERMS=(User.Read offline_access Files.Read.All Sites.Read.All Mail.Read Chat.Read
  ChannelMessage.Read.All Team.ReadBasic.All)
ARGS=()
for P in "${PERMS[@]}"; do
  ARGS+=("$(az ad sp show --id "$GRAPH" \
    --query "oauth2PermissionScopes[?value=='$P'] | [0].id" -o tsv)=Scope")
done
az ad app permission add --id "$APP_REG_ID" --api "$GRAPH" --api-permissions "${ARGS[@]}"
```

A Microsoft 365 admin (Global, Privileged Role, or Cloud Application Administrator) then
grants consent for the whole tenant, so users don't each see a consent prompt:

```bash
az ad app permission admin-consent --id "$APP_REG_ID"
```

Or in the portal: **Entra ID → App registrations → `<APPNAME>-<ENV>` → API permissions →
Grant admin consent for Ingage**. Check it with
`az ad app permission list-grants --id "$APP_REG_ID" --show-resource-name`; the Graph row
should list every permission above.

Admin consent given to another app (for example Claude Desktop's "M365 MCP Server for
Claude") doesn't apply here; each app registration needs its own.

### 6.8 Container Apps environment

```bash
az extension add --name containerapp --upgrade
az containerapp env create -g "$RG" -n "$CAE" -l "$LOCATION" \
  --logs-destination log-analytics \
  --logs-workspace-id "$LAW_CUSTOMER_ID" --logs-workspace-key "$LAW_KEY"
CAE_ID=$(az containerapp env show -g "$RG" -n "$CAE" --query id -o tsv)
APP_FQDN="$APP.$(az containerapp env show -g "$RG" -n "$CAE" --query properties.defaultDomain -o tsv)"
```

### 6.9 First image

Push an image before creating the Container App, so it never starts from a placeholder.
After this, CI/CD pushes every new image (section 8).

```bash
az acr login --name "$ACR"
docker build --platform linux/amd64 \
  --secret id=node_auth_token,env=NODE_AUTH_TOKEN \
  -t "$ACR.azurecr.io/$IMAGE:initial" .
docker push "$ACR.azurecr.io/$IMAGE:initial"
```

### 6.10 Container App

**First time only.** After CI/CD has deployed, change settings with
`az containerapp update` (for example `--set-env-vars`), or export the live definition with
`az containerapp show -g "$RG" -n "$APP" -o yaml`, edit it, and apply it with
`az containerapp update -g "$RG" -n "$APP" --yaml <file>`.

The app is defined in YAML so the probes, Key Vault references, and registry identity all
live in one place. The heredoc fills in the variables from the steps above.

- **Startup and readiness probes** call `/api/health`, which checks the database. A replica
  only gets traffic once it can reach Postgres.
- **Liveness** checks only the TCP port, so a database outage doesn't restart replicas
  over and over.
- **Migrations** run inside the container before it serves traffic. If they fail, the
  container exits with `[migrate] failed; exiting` in the logs.

```bash
cat > containerapp.yaml <<EOF
location: $LOCATION
identity:
  type: UserAssigned
  userAssignedIdentities:
    $ID_RESOURCE_ID: {}
properties:
  environmentId: $CAE_ID
  configuration:
    activeRevisionsMode: Single
    ingress:
      external: true
      targetPort: 3000
      transport: auto
    registries:
      - server: $ACR.azurecr.io
        identity: $ID_RESOURCE_ID
    secrets:
      - name: auth-secret
        keyVaultUrl: ${KV_URI}secrets/auth-secret
        identity: $ID_RESOURCE_ID
      - name: entra-client-secret
        keyVaultUrl: ${KV_URI}secrets/entra-client-secret
        identity: $ID_RESOURCE_ID
      - name: anthropic-api-key
        keyVaultUrl: ${KV_URI}secrets/anthropic-api-key
        identity: $ID_RESOURCE_ID
      - name: voyage-api-key
        keyVaultUrl: ${KV_URI}secrets/voyage-api-key
        identity: $ID_RESOURCE_ID
  template:
    containers:
      - name: app
        image: $ACR.azurecr.io/$IMAGE:initial
        resources:
          cpu: 0.5
          memory: 1Gi
        env:
          - name: AUTH_URL
            value: https://$APP_FQDN
          - name: AUTH_SECRET
            secretRef: auth-secret
          - name: AZURE_AD_CLIENT_ID
            value: $APP_REG_ID
          - name: AZURE_AD_CLIENT_SECRET
            secretRef: entra-client-secret
          - name: AZURE_AD_TENANT_ID
            value: $TENANT_ID
          - name: ANTHROPIC_API_KEY
            secretRef: anthropic-api-key
          - name: VOYAGE_API_KEY
            secretRef: voyage-api-key
          - name: ALLOWED_EMAIL_DOMAIN
            value: ingagepartners.com
          - name: PGHOST
            value: $PG.postgres.database.azure.com
          - name: PGDATABASE
            value: $APPNAME
          - name: PGUSER
            value: $ID
          - name: AZURE_CLIENT_ID
            value: $ID_CLIENT_ID
          - name: APPLICATIONINSIGHTS_CONNECTION_STRING
            value: $AI_CONNECTION
        probes:
          - type: Startup
            httpGet:
              path: /api/health
              port: 3000
            initialDelaySeconds: 3
            periodSeconds: 5
            timeoutSeconds: 6
            failureThreshold: 24
          - type: Readiness
            httpGet:
              path: /api/health
              port: 3000
            periodSeconds: 10
            timeoutSeconds: 6
            failureThreshold: 3
          - type: Liveness
            tcpSocket:
              port: 3000
            periodSeconds: 20
            failureThreshold: 3
    scale:
      minReplicas: 1
      maxReplicas: 3
EOF

az containerapp create -g "$RG" -n "$APP" --yaml containerapp.yaml
rm containerapp.yaml

echo "https://$APP_FQDN"
curl -s "https://$APP_FQDN/api/health"     # {"status":"ok"}
```

`containerapp.yaml` contains resource IDs but no secrets. It's still environment-specific, so
the commands delete it afterwards rather than commit it.

Then add the app's callback URL to the sign-in registration (section 7) and open
`https://$APP_FQDN`.

## 7. Entra app registration

Each environment has its own sign-in registration (created in 8.7) with its own client
secret and redirect URIs. Phil may create these for you; you then need only the client ID,
and the secret must be in that environment's Key Vault as `entra-client-secret`.

The redirect URI is `https://<host>/api/auth/callback/microsoft-entra-id`. For dev, also add
localhost so local sign-in works:

```bash
# dev
az ad app update --id "$APP_REG_ID" --web-redirect-uris \
  "https://$APP_FQDN/api/auth/callback/microsoft-entra-id" \
  "http://localhost:3000/api/auth/callback/microsoft-entra-id"

# prod
az ad app update --id "$APP_REG_ID" --web-redirect-uris \
  "https://$APP_FQDN/api/auth/callback/microsoft-entra-id"
```

`--web-redirect-uris` replaces the whole list, so always pass every URI you want to keep.

For local sign-in, put the dev registration's values in `.env.local`:

```bash
echo "AZURE_AD_CLIENT_ID=$APP_REG_ID"
echo "AZURE_AD_TENANT_ID=$TENANT_ID"
az keyvault secret show --vault-name "$KV" --name entra-client-secret --query value -o tsv   # AZURE_AD_CLIENT_SECRET
```

Sign-in is restricted to `ALLOWED_EMAIL_DOMAIN`. The registration is single-tenant
(`AzureADMyOrg`), so only accounts in your tenant can sign in at all.

## 8. CI/CD

| Workflow | Trigger | What it does |
|---|---|---|
| `lint-format.yml` | pull request | Biome lint, format check, `tsc` |
| `unit-tests.yml` | pull request | Vitest with coverage |
| `e2e-tests.yml` | pull request | Postgres service container, migrations, Playwright (desktop Chrome) |
| `deploy.yml` | push to `main`, manual | Build the image once → deploy to dev → **approval** → deploy the same image to prod |

The deploy workflow builds the image once and saves it as a workflow artifact. The dev job
pushes it to the dev ACR and updates the dev Container App. The prod job runs after a
reviewer approves it, then pushes the **same image** to the prod ACR and updates prod. Each
job only has credentials for its own environment.

Dev and prod deploys queue separately. A prod deploy waiting for approval doesn't stop later
merges from reaching dev. If several merges land before anyone approves, only the newest
prod deploy stays queued (older queued ones are cancelled), so approving it ships the latest
`main`.

### 8.1 Deploy identity per environment (GitHub OIDC)

Run once per environment, with the section 6 variables still set:

```bash
DEPLOY_APP_ID=$(az ad app list --display-name "github-$APPNAME-$ENV" --query "[0].appId" -o tsv)
if [ -z "$DEPLOY_APP_ID" ]; then
  DEPLOY_APP_ID=$(az ad app create --display-name "github-$APPNAME-$ENV" --query appId -o tsv)
  az ad sp create --id "$DEPLOY_APP_ID" --output none
fi
DEPLOY_SP_ID=$(az ad sp show --id "$DEPLOY_APP_ID" --query id -o tsv)

# The repo's OIDC subject prefix. New repos use GitHub's immutable format
# (repo:IngageGroup@<org id>/<repo>@<repo id>), not repo:IngageGroup/<repo>.
SUB_PREFIX=$(gh api "repos/IngageGroup/$REPO/actions/oidc/customization/sub" \
  --jq .sub_claim_prefix)
echo "subject: ${SUB_PREFIX}:environment:$ENV"

az ad app federated-credential show --id "$DEPLOY_APP_ID" \
  --federated-credential-id "github-$ENV" --output none 2>/dev/null ||
  az ad app federated-credential create --id "$DEPLOY_APP_ID" --parameters "{
    \"name\": \"github-$ENV\",
    \"issuer\": \"https://token.actions.githubusercontent.com\",
    \"subject\": \"${SUB_PREFIX}:environment:$ENV\",
    \"audiences\": [\"api://AzureADTokenExchange\"]
  }"

az role assignment create --assignee-object-id "$DEPLOY_SP_ID" \
  --assignee-principal-type ServicePrincipal --role AcrPush --scope "$ACR_ID"
az role assignment create --assignee-object-id "$DEPLOY_SP_ID" \
  --assignee-principal-type ServicePrincipal --role Contributor \
  --scope "$(az group show -n "$RG" --query id -o tsv)"
```

The subject pins the credential to one GitHub environment. A workflow job can log in as the
dev identity only when it runs in the `dev` environment, and the same goes for prod. 10.2
then restricts both environments to the `main` branch, so a workflow pushed on another branch
can't get either identity. If Azure login fails with `AADSTS700213`, the error shows the
subject GitHub sent; compare it with `az ad app federated-credential list --id "$DEPLOY_APP_ID"`.

### 8.2 GitHub environments, secrets and variables

```bash
# Create the environment and allow deployments only from main.
gh api -X PUT "repos/IngageGroup/$REPO/environments/$ENV" --silent --input - <<'JSON'
{ "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true } }
JSON
gh api "repos/IngageGroup/$REPO/environments/$ENV/deployment-branch-policies" \
  --jq '.branch_policies[].name' | grep -qx main ||
  gh api -X POST "repos/IngageGroup/$REPO/environments/$ENV/deployment-branch-policies" \
    -f name=main -f type=branch --silent

gh secret set AZURE_CLIENT_ID       --repo "IngageGroup/$REPO" --env "$ENV" --body "$DEPLOY_APP_ID"
gh secret set AZURE_TENANT_ID       --repo "IngageGroup/$REPO" --env "$ENV" --body "$TENANT_ID"
gh secret set AZURE_SUBSCRIPTION_ID --repo "IngageGroup/$REPO" --env "$ENV" --body "$SUBSCRIPTION_ID"

gh variable set ACR_NAME       --repo "IngageGroup/$REPO" --env "$ENV" --body "$ACR"
gh variable set CONTAINER_APP  --repo "IngageGroup/$REPO" --env "$ENV" --body "$APP"
gh variable set RESOURCE_GROUP --repo "IngageGroup/$REPO" --env "$ENV" --body "$RG"
```

Then, in the GitHub UI:

1. **Settings → Environments → prod:** turn on **Required reviewers** and add the people who
   approve production deploys.
2. **Settings → Branches (or Rules) → add a rule for `main`:** require a pull request before
   merging, and require the **Lint & Format**, **Unit Tests**, and **E2E Tests** checks to
   pass. The deploy workflow doesn't run tests itself. It trusts that `main` only gets
   reviewed, passing code.

### 8.3 Dependabot

`.github/dependabot.yml` updates npm packages and Actions weekly, grouped, after a 7-day
cooldown. To reach the private `@ingagegroup` packages it needs a token. Create a classic PAT
with `read:packages` and add it as a Dependabot secret:

```bash
gh secret set DEPENDABOT_PACKAGES_TOKEN --repo "IngageGroup/$REPO" --app dependabot
```

## 9. Custom domain

```bash
DOMAIN=<YOUR_DOMAIN>    # e.g. myapp.ingagepartners.com

# 1. Get the DNS records to create
az containerapp hostname add -g "$RG" -n "$APP" --hostname "$DOMAIN"
echo "CNAME  $DOMAIN  ->  $APP_FQDN"
echo "TXT    asuid.$DOMAIN  ->  $(az containerapp show -g "$RG" -n "$APP" --query properties.customDomainVerificationId -o tsv)"

# 2. After DNS has propagated: issue a free managed certificate and bind it
az containerapp hostname bind -g "$RG" -n "$APP" --hostname "$DOMAIN" \
  --environment "$CAE" --validation-method CNAME

# 3. Point Auth.js and the sign-in registration at the new host
az containerapp update -g "$RG" -n "$APP" --set-env-vars "AUTH_URL=https://$DOMAIN"
az ad app update --id "$APP_REG_ID" --web-redirect-uris \
  "https://$DOMAIN/api/auth/callback/microsoft-entra-id" \
  "https://$APP_FQDN/api/auth/callback/microsoft-entra-id"
```

## 10. Logs & monitoring

**Live console output:**

```bash
az containerapp logs show -g "$RG" -n "$APP" --follow --tail 50
```

**Query logs in Log Analytics** (portal: Log Analytics workspace → Logs). Workspaces that
receive logs through a shared key use the `_CL` tables:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "ca-<APPNAME>-dev"
| where Log_s has_any ("[migrate]", "[api/", "[db]", "[proxy]")
| project TimeGenerated, RevisionName_s, Log_s
| order by TimeGenerated desc
```

From the CLI:

```bash
az monitor log-analytics query -w "$LAW_CUSTOMER_ID" --analytics-query \
  "ContainerAppConsoleLogs_CL | where ContainerAppName_s == '$APP' | order by TimeGenerated desc | take 50" \
  -o table
```

Server errors include a correlation ID (`[api/chat 1a2b3c4d] …`) that also appears in the
API's 500 response, so you can search for it.

**Application Insights** (`appi-<APPNAME>-<ENV>`) shows requests, dependencies (including
Postgres), and exceptions. It's turned on by `APPLICATIONINSIGHTS_CONNECTION_STRING`. Local
dev and CI don't set it, so they send nothing.

### 10.1 Chat privacy check

Conversations aren't saved, and question and answer text must not reach logs or telemetry
either. How the code keeps it out:

- `/api/chat` logs only a correlation id, the failed step, and `describeError(err)`: the
  error's name plus its HTTP status, error type/code, SQLSTATE, and request id. Upstream error
  messages are dropped because Anthropic, Voyage, and Postgres can echo request content in
  them. Errors the app writes itself (`SafeError`, `VoyageError`) keep their message.
- The Claude client is created with `logLevel: "warn"`, so `ANTHROPIC_LOG=debug` can't make
  the SDK print request bodies.
- `src/lib/telemetry.ts` sets the Azure Monitor options: Postgres spans record SQL text but
  never parameter values (the question is always a parameter), HTTP spans carry no headers or
  bodies, and console output isn't collected.

To check a deployment by hand, ask one question in the app with a distinctive word in it (for
example "zebracorn"), wait a few minutes, then search everything the app sent. Every query
must return no rows.

```kusto
// Application Insights (appi-<APPNAME>-<ENV>) → Logs
union traces, requests, dependencies, exceptions, customEvents
| where timestamp > ago(1h)
| where * has "zebracorn"
```

```kusto
// Log Analytics workspace (log-<APPNAME>-<ENV>) → Logs
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where Log_s has "zebracorn"
```

### 10.2 Answer outcomes by topic

The chat counts its answers without keeping any question or answer text or who asked. Two
tables hold daily counters (UTC days):

- `chat_outcome_counts`: per day, topic, and outcome (`answered`, `dont-know`, `off-topic`,
  `error`). The topic is the topic check's result, or `unclassified` when the check failed.
- `chat_citation_counts`: per day and topic, how often each section was cited.

A high `dont-know` share for a topic points at a gap in its documents. Connect as the Entra
admin as in section 6.6 (firewall rule, then `PGPASSWORD` from
`az account get-access-token --resource-type oss-rdbms`), then:

```sql
-- Daily counts by topic and outcome, last 30 days
SELECT day, topic, outcome, count
FROM chat_outcome_counts
WHERE day > current_date - 30
ORDER BY day DESC, topic, outcome;

-- Don't-know share per topic, last 30 days
SELECT topic,
       coalesce(sum(count) FILTER (WHERE outcome = 'dont-know'), 0) AS dont_know,
       sum(count) AS total,
       round(100.0 * coalesce(sum(count) FILTER (WHERE outcome = 'dont-know'), 0) / sum(count)) AS pct
FROM chat_outcome_counts
WHERE day > current_date - 30 AND outcome <> 'off-topic'
GROUP BY topic;

-- Most cited sections, last 30 days
SELECT topic, section, sum(count) AS citations
FROM chat_citation_counts
WHERE day > current_date - 30
GROUP BY topic, section
ORDER BY citations DESC
LIMIT 20;
```

