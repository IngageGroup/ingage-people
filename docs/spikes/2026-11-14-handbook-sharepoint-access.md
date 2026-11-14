# Spike: Ingage handbook location and SharePoint access (issue #1)

Date: 2026-11-14. Issue: https://github.com/IngageGroup/ingage-people/issues/1

This spike needs a person with Ingage Microsoft 365 access (to find the file) and a
Microsoft 365 admin (to grant access). This document lists what is already known, the exact
steps for each task, and the text to post back on the issue.

## What we already know

- The SharePoint tenant is `revisioncollective.sharepoint.com`. All Ingage and Revolution
  Collective sites live under it.
- Candidate sites for the handbook:
  - **The Hive**: `https://revisioncollective.sharepoint.com/sites/Hive`, the Ingage
    intranet (also at `hive.ingagepartners.com`). It holds Ingage Day slides, events, and
    "Be the Change".
  - **RC Connect**: `https://revisioncollective.sharepoint.com/sites/RCConnect`, the
    Revolution Collective-wide site (for example, the donation match form).
  - A third site, `https://revisioncollective.sharepoint.com/sites/IngageDocumentLibrary`,
    holds Ingage practice and leadership documents. Check it too.
- A search of Slack and email found no direct link to the handbook.
- Each environment already has a user-assigned managed identity, `id-<APPNAME>-<ENV>`
  (README 8.3). Azure access and app registrations go through Phil Lachmann (README 2 and 9).

Guess (not verified): an Ingage-specific handbook more likely lives on The Hive, and
RC Connect more likely holds Revolution Collective-wide documents. Check RC Connect as well,
and make sure you pick the **Ingage** handbook, not another entity's.

## Recommendation: managed identity, not a client secret

Grant `Sites.Selected` to a **managed identity** in each environment rather than to an app
registration with a secret:

- No secret to store, rotate, or leak, so the Key Vault task becomes "nothing to store".
- `@azure/identity` `ManagedIdentityCredential` works the same way the Postgres token does today.
- Use a separate identity for ingestion, `id-<APPNAME>-ingest-<ENV>`, assigned only to the
  nightly Container Apps Job (issue #9). The web replicas then never get SharePoint access.
  Reusing `id-<APPNAME>-<ENV>` is simpler but gives the web app read access to the site too.

Local development uses the downloaded copy through the `local-file` source (issue #6), so
local work needs no SharePoint credential. If a developer does need to call Graph locally,
the fallback is a dev-only app registration with a **certificate** credential in
`kv-<APPNAME>-dev`. Don't use one in prod.

## Task 1: find the file

Do this as an Ingage user, in a browser:

1. Search for "handbook" on The Hive, RC Connect, and IngageDocumentLibrary. Also check
   each site's **Documents** / **Site contents** and the HR or People pages.
2. Open the file and note: the site URL, the library (drive) name, the folder path, the file
   name, and the type (`.pdf` or `.docx`).
3. Copy a link: **Copy link** in the document library, or the address bar.

Or, in Graph Explorer (https://developer.microsoft.com/graph/graph-explorer), signed in as
yourself, with delegated `Sites.Read.All` / `Files.Read.All`:

```http
POST https://graph.microsoft.com/v1.0/search/query
{ "requests": [ { "entityTypes": ["driveItem"],
    "query": { "queryString": "handbook filetype:pdf OR handbook filetype:docx" } } ] }
```

## Task 2: record the Graph identifiers

The easiest way is to resolve the file's sharing link. In Graph Explorer, as yourself:

```bash
# Encode the link: "u!" + base64url(link), no padding
URL='<paste the file link>'
echo -n "u!$(printf %s "$URL" | base64 -w0 | tr '/+' '_-' | tr -d '=')"
```

```http
GET https://graph.microsoft.com/v1.0/shares/{encoded}/driveItem?$select=id,name,file,webUrl,eTag,lastModifiedDateTime,parentReference
```

Read the result like this:

| Field | Where it comes from |
|---|---|
| site id | `parentReference.siteId` (form: `host,siteCollectionGuid,webGuid`) |
| drive id | `parentReference.driveId` |
| item id | `id` |
| file type | `file.mimeType` (`application/pdf` or `application/vnd.openxmlformats-officedocument.wordprocessingml.document`) |
| web URL | `webUrl` (citations link here, plus `#page=N` for PDFs) |

To get the site id without the link:
`GET https://graph.microsoft.com/v1.0/sites/revisioncollective.sharepoint.com:/sites/Hive?$select=id,webUrl`

Record the **item id**, not the path. Graph keeps the item id when the file is renamed or
moved within the drive. It does not keep it if someone deletes the file and uploads a
replacement, so ask HR to update the file in place (upload a new version).

## Task 3: create the ingestion identity (per environment)

Run this for `ENV=dev` and again for `ENV=prod`. Set the variables as in README 8.1. If Phil
creates identities for you, ask him to run it.

```bash
IID=id-$APPNAME-ingest-$ENV
az identity create -g "$RG" -n "$IID" -l "$LOCATION"
IID_CLIENT_ID=$(az identity show -g "$RG" -n "$IID" --query clientId -o tsv)
IID_PRINCIPAL_ID=$(az identity show -g "$RG" -n "$IID" --query principalId -o tsv)
echo "$ENV ingest identity: clientId=$IID_CLIENT_ID principalId=$IID_PRINCIPAL_ID"
```

Send both ids to the admin (task 4). The job in issue #9 uses `IID_CLIENT_ID` as its
`AZURE_CLIENT_ID`.

## Task 4: ask a Microsoft 365 admin for `Sites.Selected`, read, on one site

Granting access takes two steps, and both need an admin.

**4a. Graph application permission `Sites.Selected`.** A managed identity has no consent
screen in the portal, so the admin assigns the app role directly (needs Privileged Role
Administrator or Global Administrator):

```bash
GRAPH_SP_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 --query id -o tsv)
ROLE_ID=$(az ad sp show --id 00000003-0000-0000-c000-000000000000 \
  --query "appRoles[?value=='Sites.Selected'].id | [0]" -o tsv)
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$IID_PRINCIPAL_ID/appRoleAssignments" \
  --body "{\"principalId\":\"$IID_PRINCIPAL_ID\",\"resourceId\":\"$GRAPH_SP_ID\",\"appRoleId\":\"$ROLE_ID\"}"
```

**4b. Read access on the handbook site only.** A SharePoint admin runs this, either with
`Sites.FullControl.All` in Graph or with PnP PowerShell:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
{ "roles": ["read"],
  "grantedToIdentities": [ { "application": {
      "id": "<IID_CLIENT_ID>", "displayName": "id-<APPNAME>-ingest-<ENV>" } } ] }
```

```powershell
Grant-PnPAzureADAppSitePermission -AppId <IID_CLIENT_ID> -DisplayName "id-<APPNAME>-ingest-<ENV>" `
  -Site https://revisioncollective.sharepoint.com/sites/<Site> -Permissions Read
```

Draft request to send to the admin:

> Hi, we're building Ingage People, an internal app that answers HR questions from the Ingage
> employee handbook. A nightly job needs to read one file:
> `<file web URL>` on `<site URL>`.
>
> We'd like least-privilege, app-only access:
> 1. Graph application permission **Sites.Selected** for these managed identities:
>    dev `<dev clientId / principalId>`, prod `<prod clientId / principalId>`.
> 2. A **read** site permission for both identities on **only** `<site URL>`
>    (`POST /sites/{site-id}/permissions` or `Grant-PnPAzureADAppSitePermission -Permissions Read`).
>
> No other sites and no write access. The commands are attached. Thanks!

If the handbook sits on a large shared site (like RC Connect), think about asking HR to put
it in its own library or a small dedicated site. `Sites.Selected` covers the whole site, so
this keeps the grant to one document.

## Task 5: credential storage

With a managed identity there is nothing to store in Key Vault. Record "managed identity,
no secret" on the issue. Only if the admin grants an app registration instead: store the
certificate (preferred) or secret in `kv-<APPNAME>-<ENV>` as `sharepoint-ingest-credential`,
and set `SHAREPOINT_CLIENT_ID` on the job.

## Task 6: local copy for development

Download the file through the SharePoint UI. Keep it outside the repo, for example
`~/ingage-data/ingage-handbook.pdf`, and point the `local-file` source (issue #6) at it with
an env var in `.env.local`. Never commit it. As a guard, add `*.pdf`/`*.docx` under a
`/data/` ignore rule if anyone starts keeping copies near the repo.

## Acceptance check

A managed identity token can only be obtained from inside Azure. After 4a and 4b, run this
from a shell in the dev container that has the ingest identity, for example
`az containerapp exec -g "$RG" -n <app or job> --command sh`. It uses Node because the image
may not have curl:

```bash
node -e '
const { IDENTITY_ENDPOINT: ep, IDENTITY_HEADER: h } = process.env;
const cid = process.argv[1], site = process.argv[2], drive = process.argv[3], item = process.argv[4];
(async () => {
  const t = await (await fetch(`${ep}?resource=https://graph.microsoft.com&api-version=2019-08-01&client_id=${cid}`,
    { headers: { "X-IDENTITY-HEADER": h } })).json();
  const auth = { Authorization: `Bearer ${t.access_token}` };
  const base = `https://graph.microsoft.com/v1.0/sites/${site}/drives/${drive}/items/${item}`;
  const meta = await fetch(`${base}?$select=name,eTag,lastModifiedDateTime,size,file`, { headers: auth });
  console.log(meta.status, await meta.text());
  const body = await fetch(`${base}/content`, { headers: auth });
  console.log("content", body.status, (await body.arrayBuffer()).byteLength, "bytes");
})();
' "$IID_CLIENT_ID" "<site-id>" "<drive-id>" "<item-id>"
```

To pass, the metadata call returns 200 with `eTag` and `lastModifiedDateTime`, and the content
call returns 200 with a non-zero byte count. Then check that the grant really is limited to
one site: the same token against another site, for example
`GET /sites/revisioncollective.sharepoint.com:/sites/RCConnect`, should return **403**.

## Comment to post on issue #1 when done

```markdown
## Findings
- **Site:** <site URL> (The Hive | RC Connect | IngageDocumentLibrary)
- **Library / path:** <library> / <folder path>
- **File:** <file name>, **type:** PDF | Word (.docx)
- **Web URL:** <webUrl>

## Graph identifiers
| | dev / prod (same file) |
|---|---|
| site id | `<site-id>` |
| drive id | `<drive-id>` |
| item id | `<item-id>` |

## Access
- Identity: managed identity `id-<APPNAME>-ingest-dev` (clientId `<…>`), `id-<APPNAME>-ingest-prod` (clientId `<…>`)
- `Sites.Selected` app role granted by <admin> on <date>; site permission `read` on <site URL> only.
- Credential: none (managed identity), so nothing in Key Vault.
- Verified <date>: metadata 200 (eTag `<…>`, lastModified `<…>`), content 200 (<n> bytes); other site → 403.

## Local copy
Downloaded to a path outside the repo; `local-file` source env var: `<NAME>`.
```
