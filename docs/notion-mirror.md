# Notion mirror

A read-only Notion dashboard over the ops Postgres database.

Postgres stays the system of record. Nothing in this feature writes to it, and
nothing reads user edits back out of Notion. Notion is a window: if someone
edits a mirrored row there, the next sync overwrites it. Actions — generating a
BOL, retrying a job, sending an invoice — stay in the app at `ops.tlmbg.co`,
and every mirrored row carries an **Open in Ops** link back to them.

## Why it is safe to run against production

Two independent guarantees, because the first can be undone by a human editing
environment variables and the second cannot:

1. **Separate credential.** The sync connects with `NOTION_SYNC_DATABASE_URL`,
   a Postgres role granted only `SELECT`. `lib/notion/extract.ts` refuses to
   start if that value is identical to `DATABASE_URL`.
2. **Server-enforced read-only transactions.** Every statement runs inside
   `START TRANSACTION READ ONLY`. Postgres rejects any write with
   `cannot execute UPDATE in a read-only transaction`, regardless of role.

It also never imports `lib/db.ts`, so the app's read-write Prisma client is not
reachable from this code path. `__tests__/notion-mirror.test.ts` asserts all
three properties.

Nothing here touches the Google Sheet or `lib/sheetSync.ts`.

## One-time setup

### 1. Create the read-only Postgres role

In the Neon SQL editor, against the production database:

```sql
CREATE ROLE notion_mirror WITH LOGIN PASSWORD '<generate a strong one>';
GRANT CONNECT ON DATABASE <dbname> TO notion_mirror;
GRANT USAGE ON SCHEMA public TO notion_mirror;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO notion_mirror;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO notion_mirror;
```

The `ALTER DEFAULT PRIVILEGES` line matters: without it, tables added by a
future migration are invisible to the mirror and the sync fails on a table it
has never seen.

### 2. Create the Notion integration

1. <https://www.notion.so/my-integrations> → **New integration**, internal, in
   the Leopard Mark workspace. Give it **no** user-information capabilities; it
   only needs content read/update/insert.
2. Copy the Internal Integration Secret.
3. In Notion, create the page the dashboard will live under (e.g. "Ops").
   **Share → Connect to → your integration.** Databases are created as children
   of this page and inherit that access.
4. Copy the page id — the 32 hex characters in its URL.

### 3. Environment

Add to `.env.local` locally and to the Vercel project settings for production:

```
NOTION_TOKEN=ntn_...
NOTION_PARENT_PAGE_ID=<32 hex chars>
NOTION_SYNC_DATABASE_URL=postgres://notion_mirror:...@.../<dbname>?sslmode=require
NOTION_OPS_BASE_URL=https://ops.tlmbg.co   # optional, this is the default
```

`CRON_SECRET` is already set for `/api/cron/jobs` and is reused here.

### 4. Provision and backfill

```bash
npm run notion:sync -- --dry-run     # reads Postgres, writes nothing
npm run notion:provision             # creates the 12 databases, writes notion-databases.json
npm run notion:sync -- --full        # backfill, ~10 minutes for 1,647 rows
```

Commit `notion-databases.json` — production needs it to know which databases to
write to. The ids are not secrets; they are useless without `NOTION_TOKEN`.

## Running it

```bash
npm run notion:sync -- --dry-run              # row counts, no Notion calls
npm run notion:sync -- --full                 # rebuild every row
npm run notion:sync -- --since 2h             # rows changed in the last 2 hours
npm run notion:sync -- --only accounts,orders # one or more databases
```

On a mapper change in `lib/notion/sync.ts`, run `--full`. Incremental runs only
touch rows whose `updated_at` moved, so existing pages would keep the old shape.

### Scheduled refresh

`app/api/cron/notion/route.ts` runs a 25-hour incremental window (deliberately
wider than the cron period so a late or retried run leaves no gap). To schedule
it, add to `vercel.json`:

```json
{ "path": "/api/cron/notion", "schedule": "0 10 * * *" }
```

**Check the plan before deploying that.** The existing cron comment notes this
project is on Vercel Hobby, which allows daily schedules only and caps the
number of cron jobs. If adding a second entry is rejected at deploy time, the
options are to upgrade the plan or to call the route from an external scheduler
with the `Authorization: Bearer $CRON_SECRET` header.

Until a cron exists, the mirror refreshes when someone runs `npm run
notion:sync`. It is a dashboard, not a ledger — staleness is a display problem,
never a correctness one.

## Sharing with people outside the company

Notion permissions are **per database, not per property**. A guest invited to a
database sees every column in it. These four carry pricing or billing data and
must stay internal:

| Database | Why |
|---|---|
| Products | list price, deposit |
| Orders | order value |
| Order Lines | unit pricing |
| Invoices | amounts, Stripe links |

`provision.ts` prints this list, and `DbDef.internalOnly` in
`lib/notion/schema.ts` is the source of truth. To share safely, put the
shareable databases (Accounts, Contacts, Prospects, Delivery Routes, Route
Stops, Documents, Inventory, Automations) on their own Notion page and invite
guests to that page, not to the parent.

## What is mirrored

| Notion database | Source | Rows at last count |
|---|---|---|
| Accounts | `accounts` + rep name | 127 |
| Contacts | `contacts` | 102 |
| Products | `products` | 21 |
| Orders | `orders` + line total | 276 |
| Order Lines | `order_lines` | 295 |
| Invoices | `invoices` | 203 |
| Prospects | `public/rep-app/assets/js/prospects.js` + `prospect_visits` | 551 |
| Delivery Routes | `delivery_routes` + driver, warehouse | 4 |
| Route Stops | `route_stops` + photo count | 6 |
| Documents | `archived_documents` | 16 |
| Inventory | `available_for_delivery` view | 12 |
| Automations | `job_runs`, last 30 days | 34 |

Prospects come from the rep app's static data file because that file is the
permanent key space for prospect ids; `prospect_visits` supplies status, rep and
note where a rep has marked one.

## Known limits

- **Deletes are never propagated.** A row removed from Postgres leaves its
  Notion page in place. A mirror bug must not be able to erase something a
  person is reading. Prune stale pages by hand.
- **Notion edits do not travel back.** By design.
- **No uniqueness enforcement in Notion.** Upserts key on `External ID`, so the
  sync will not duplicate; a human adding a row by hand can.
- **`order_events` is not mirrored.** 320 rows of append-only audit trail with
  no useful Notion shape. It stays in the app.
- **Rate limit.** Notion allows ~3 requests/second, so a full rebuild takes
  about ten minutes. Incremental runs are seconds.
