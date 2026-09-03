# Ops Platform — build notes

Companion to `docs/OPS-PLATFORM-BUILD-PROMPT.md`. What is built, what is
verified, what is deliberately not built yet, and how to run it.

Everything here is additive. The rep app (`public/rep-app`), the Apps Script
backend and the Google Sheet are untouched and still authoritative for order
entry; nothing in this build changes how a rep places an order today.

---

## Run it

```bash
# 1. A local Postgres to develop against (never point this build at Neon while
#    testing — it writes orders, mints BOL numbers and calls Stripe).
npx prisma dev --name ops-platform-test --detach     # prints a DATABASE_URL
export DATABASE_URL="postgres://postgres:postgres@localhost:<port>/template1?sslmode=disable"
export DATABASE_URL_UNPOOLED="$DATABASE_URL"

# 2. Schema + config + catalog
npx prisma migrate deploy
npx tsx scripts/import-foundation-data.ts     # accounts, reps, the 6 priced SKUs
npx tsx scripts/seed-ops-platform.ts          # locations, routes, commodities, rules
                                              # (--dry-run to preview)

# 3. Demo data that exercises the real pipeline end to end
npx tsx scripts/dev/demo-pipeline.ts          # dev only; refuses a hosted DB

# 4. Run
AUTH_SECRET=dev-only-secret npx next dev
# sign in at /admin/login — the demo script creates
#   Jack Begley (admin) · Dany (ops) · Warehouse — Benicia (warehouse) · Daniel (docs_only)
#   all with PIN 1234
```

`npx prisma dev ls` lists local servers; `npx prisma dev stop <name>` stops one.

### Env vars this build reads that were not already set

| Var | Needed for | Behaviour if unset |
|---|---|---|
| `CRON_SECRET` | Authenticating Vercel Cron to `/api/cron/jobs` | **In production the route returns 503.** It fails closed on purpose: without it, that URL is an unauthenticated way to make the system send invoices. |
| `STRIPE_WEBHOOK_SECRET` | Verifying Stripe webhook signatures | Webhook returns 401 (pre-existing behaviour) |
| `APPS_SCRIPT_URL`, `SYNC_SHARED_SECRET` | DB → Sheet mirror | `syncOrderToSheet` returns `ok:false`; jobs retry then dead-letter |
| `APP_BASE_URL` | Links in Slack digests | Falls back to `https://ops.tlmbg.co` |
| `SLACK_CHANNEL_INVENTORY` | Reorder alerts | Alerts computed but not posted |

---

## What is built

### Data model (§4)
`prisma/migrations/20260902130000_add_ops_platform` — additive, no renames.
Adds `UserRole`, `UserLocation`, `Location`, `RouteSchedule`,
`RegionSlackChannel`, `Commodity`, `InventoryEvent`, `Shipment`, `BolSequence`,
`DocumentLog`, `KegCustodyEntry`, `JobRun`, `AutomationRule`, `StripeEvent`;
enriches `Product`, `Order`, `Invoice`, `Account`.

Two SQL views do the netting: `stock_by_location` and `available_for_delivery`
(warehouses only, minus what scheduled orders have already promised).

One hand-written piece of that migration is worth knowing about. Prisma's
generated diff wanted to `DROP` and re-add `reps.role` to change its enum type,
which would have silently reset every existing admin to `rep`. It is rewritten
as an in-place `ALTER COLUMN ... TYPE ... USING` cast, so the data survives.

### The pipeline (§3)
`lib/pipeline.ts`. `OrderStatus` stays the contract lifecycle — the compliance
gate `draft → pending_confirmation → confirmed` is untouched — and the seven
stages are *derived* by one pure function from fulfillment and billing columns.
`blocked` is an overlay carrying the stage it blocks, so a blocked card keeps
its board column.

The contract gate now outranks every fulfillment fact: an order that has not
reached `confirmed` cannot appear past ①, however its other columns look.

### The Sheet mirror gate
`syncOrderToSheet` now **refuses** any order outside
`SHEET_MIRRORABLE_STATUSES` (`confirmed`, `scheduled`, `fulfilled`).

This replaces what `__tests__/confirmation-gate-adjacency.test.ts` used to
guarantee. That test asserted the mirror had *no automatic caller at all*, which
was true while orders still reached the Sheet via Apps Script. The job runner is
now a legitimate automatic caller, so a call-site allowlist alone would only
prove somebody remembered to edit the test. The invariant moved into the
choke-point, and the test now asserts the refusal directly — a future caller
cannot bypass it by being written before someone reads the test file.

### Jobs (§2 rule 5, §7)
`lib/jobs/` — a Postgres queue drained by Vercel Cron every minute
(`vercel.json`, `app/api/cron/jobs`). Idempotency key per (kind, subject),
`FOR UPDATE SKIP LOCKED` claiming, the §6.5 backoff ladder (1m/5m/30m/2h/12h),
dead-letter after `maxAttempts`, retry and discard from the hub.

Not Inngest/Trigger.dev: the hub has to render the run log either way, and once
run history must be queryable from our own database, a hosted queue would mean
two copies of the same truth.

### Delivery (⑤) — `lib/delivery.ts`
One transaction mints the BOL from a real locked counter, writes one `DELIVERY`
event per line, `RETURN` events for empties, moves keg custody, stamps
`deliveredAt` (which is what Net 30 counts from), and enqueues the invoice.
Idempotent — a double-tap in a warehouse does not mint a second BOL.

`BolSequence` replaces two broken schemes: the Inventory app's unlocked
scan-and-increment (two people marking delivered in the same second get the same
number) and the BOL Maker's four random digits with no collision check.

### Invoicing (§6) — `lib/billing/`
`compose.ts` is pure and asserted against the real INV26277: one item per line,
`Keg Deposit` at +$35/keg, `Keg Deposit Returned` at −$35/empty, the exempt-tax
line and both § 25509 / § 25509.1 sentences verbatim, our own INV# in
`custom_fields` (Stripe's numbering is immutable per account and cannot be ours).

Due date is computed from `deliveredAt`, not from finalization. Stripe's
`days_until_due` counts from finalization, which would put a legally wrong date
on the document.

A pickup-only visit can net negative. Stripe will not finalize a negative
invoice, so the excess becomes a customer balance credit rather than vanishing.

### One renderer (§13) — `lib/bol/render.ts`
Replaces the copy in the Inventory app and the hand-synced copy in the BOL
Maker, which had already drifted: the BOL Maker's version had gained SKU and lot
columns, the package-type line break and the `@page`/`print-color-adjust` rules
that make the navy bars actually print. **That is the version kept.**

Delivery receipts still show weight and never price (Inventory commit 79a0f57).

### The hub (§8) — `app/ops/`
Command Center, Orders (board + table), Order detail with the seven-node
timeline, Accounts + detail, Deliveries week view, Inventory, Documents,
Billing, Payment setup links, Automations, Settings, Search. Plus `/docs`, the
paperwork-only maker for `docs_only`.

Design tokens come from `public/rep-app/assets/css/app.css` so the hub and the
rep app are one brand. Two departures from the mockup, both because the mockup
could not ship what the real app can: the real brand faces (Bowery Lane / Tomato
Grotesk / Bogart) are served from `/rep-app/assets/fonts/` instead of Barlow,
and the monospace is the platform stack rather than a Google-hosted IBM Plex —
§8 asks for aligned digits, which `font-variant-numeric: tabular-nums` gives
without blocking first paint on fonts.googleapis.com.

The attention queue is **computed, not stored**. There is no alerts table to go
stale — which is the direction the prototype's permanently-empty `ALERTS` array
was heading.

### Access (§2 rule 6)
The Credentials login used to refuse everyone but admins, which made "can hold a
session" and "may do anything" the same question. Five roles now share one PIN
login, so those questions came apart and the checks moved to where the role
means something:

- `proxy.ts` — host routing plus route access. **This is also where `/admin`
  gained an explicit `role === "admin"` check.** Without that line, widening the
  login would have widened `/admin` with it.
- `lib/ops/roles.ts` — the pure policy (framework-free, so it is testable).
- `lib/ops/session.ts` — `requireOpsUser` / `assertRole` / `assertLocation`,
  re-checked inside every mutating page and action. The proxy is a convenience;
  this is the boundary.

A `warehouse` user with no locations assigned can act **nowhere** — fail closed,
so a half-finished setup never reads as "allow everything".

### Host routing (§2 rule 1)
`ops.tlmbg.co → /ops`, `inventory.tlmbg.co → /ops/inventory`,
`bol.tlmbg.co → /docs`, `ach.tlmbg.co → /ops/billing/setup-links`, as a
**rewrite** so the operator stays on the branded host and old bookmarks keep the
hostname they were saved with. `orders.tlmbg.co` is deliberately absent — the
rep app keeps serving exactly as today until the Phase R cutover.

---

## Verified, not asserted

Against a local Postgres, with output in the session transcript:

- **Migration** applies from scratch through all 8 migrations; `migrate diff`
  against the schema reports an empty diff (no drift); both views queryable;
  `UserRole` has all five values; `RepRole` dropped with data preserved.
- **189 tests pass** (15 files), including the 18 pre-existing DB-backed ones.
- **`next build`** compiles all 25 routes; `eslint` reports 0 errors.
- **End-to-end pipeline** (`scripts/dev/demo-pipeline.ts`): slot proposed
  `2026-09-04 from WH-WIL` → scheduled → `markDelivered` minted
  `BOL-WH-BEN-260902-02`, wrote 3 ledger events, moved custody +3, enqueued the
  invoice. Derived stages came back `new_order`, `needs_scheduling`,
  `scheduled`, `blocked (license_expired, at scheduled)`, `delivered`.
- **Stock netting** after that delivery: `CNT1AKHB01` 24 → 20,
  `CNT1AKSB01` 22 (−2 delivered, +1 returned, twice), and
  `SGB1AKHB01 on_hand=24 available=20` — the reservation showing up.
- **BOL concurrency**: 8 parallel mints → 8 distinct contiguous numbers
  (and 10 with a gap-free sequence assertion in `bol-sequence.test.ts`).
- **All 13 hub screens** return 200 with real data. The pipeline strip read
  ① 6 · ② 20 · ③ 2 · ④ 4 · ⑤ 2 · ⑥ 0 · ⑦ 0.
- **Printed receipt** carries the real BOL number, `436 lbs` total weight
  (2×160 + 2×58), the empty-keg pickup block, `@page size: letter`, and **zero
  price symbols**.
- **Role gating**: `docs_only` → `/ops` redirects to `/docs`; `/docs` 200;
  `/admin` redirects to `/docs` in one hop.

### One bug this verification caught
The pipeline strip and orders board showed stage ③ as permanently empty while
the order detail page showed it correctly. A slot proposal is an `OrderEvent`,
not a column, and the list query was not loading it — so `pipelineStage()` never
saw a proposal from a list. Fixed in `lib/ops/queries.ts` (`ORDER_INCLUDE` now
selects the latest `order.slot_proposed`); ③ went from 0 to 2 and ② dropped
correspondingly.

---

## Not built yet

Honest list, roughly in the order it would matter:

1. **The order-confirmation trigger.** Nothing yet enqueues
   `sync_order_to_sheet` / `slack_new_order` / `stock_check` /
   `propose_delivery_slot` on `order.confirmed`, because no path in this repo
   creates a confirmed order yet — reps still go through Apps Script. The
   handlers are written and tested; they need a call site, which is Phase R
   (`/api/rep/*`).
2. **`scripts/migrate-inventory-from-sheet.ts`** (§4 steps 1–7). The schema,
   views and netting are in place and the seed loads locations, routes,
   commodities and product enrichment — but the historical `Inventory Ledger`
   import and the SKU-by-SKU parity proof against `inventory.tlmbg.co` are not
   written. **Do not retire the old dashboard before that parity check runs.**
3. **Sheet ownership registry for the new tabs** (§5). `lib/sheetColumns.ts`
   still covers the Sales tab only; the per-tab registry for `BOLs`,
   `SKU Master`, `Inventory Ledger` etc. is not built, and neither are the
   Code.gs actions to write them. This is the "5-place coordinated change".
4. **Inventory write UI** — `/ops/inventory/movement` and `/transfer` are linked
   but not built. `lib/inventory.ts` and `lib/delivery.ts` have the primitives.
5. **Drag-to-schedule** on the board and deliveries week view. Scheduling works
   through the form on the order detail page.
6. **Freight BOL form** for `/docs`. The renderer supports it fully; only the
   delivery-receipt form is built.
7. **Rep app changes** (§9) — setup-checklist response, Mark delivered, stage
   chips.
8. **Remaining §11 tests**: `inventory-stock` covers netting but not view-vs-app
   parity; `first-order`, `jobs` (queue integration, as opposed to the pure
   backoff/idempotency tests that exist), `billing-email-resolution` (covered
   inside `account-checklist`), `sheet-ownership`.

---

## Answers I assumed (§12) — please confirm

§12 says not to guess. These are the spec's or the mockup's own stated defaults,
seeded as **data** so correcting any of them is an `UPDATE`, not a deploy. But
they are assumptions, and three of them can produce a wrong document or a wrong
truck.

| # | Question | Assumed | Where it lives |
|---|---|---|---|
| 1 | Region → warehouse → weekdays, cutoff | BA → WH-SF/WH-BEN, Tue + Thu; LA → WH-WIL, Wed + Fri; 14:00 prior-day cutoff. Auto-schedule **off** for both. | `RouteSchedule`, `AutomationRule` |
| 2 | All accounts sales-tax exempt? | Yes — `Account.taxExempt` defaults `true`. A column, not a constant, so a non-exempt account is a data change. | `accounts.tax_exempt` |
| 3 | Keg deposits | $35 on ½ and ⅙ (per INV26277). **GSP/SGS and MicroStar unconfirmed.** | `products.deposit_amount` |
| 4 | Billing email source | `Account.billingContactEmail` → ordering `Contact.email` → block the invoice. Rep app does not yet require it. | `lib/ops/checklist.ts` |
| 5 | Invoice timing | Immediate on delivery, rule-toggleable. | `auto_invoice_on_delivery` |
| 6 | `docs_only` users / warehouse scoping | Daniel = `docs_only`. Warehouse scoping is per-user and **empty by default**. | `UserLocation` |
| 7 | Slack channels | Keep BA/LA from env. `#inventory` / `#billing` need channel IDs. | `RegionSlackChannel` |
| 8 | Delivery receipts: weight or price | Weight, as today. No signature capture. | `lib/bol/render.ts` |
| 9 | Port anything from the prototype? | No, per the spec's default. | — |

---

## Deployed — 2026-09-02

`ops.tlmbg.co` is live and serving this app.

| Step | Done |
|---|---|
| Production Neon migrated | `20260831230000_add_stripe_billing_and_inventory` + `20260902130000_add_ops_platform`. Zero drift afterwards; both views present; `Jack Begley` still `admin` (the hand-written `USING` cast preserved role data); 108 accounts and 0 orders intact. |
| Production config seeded | 11 locations, 7 commodities, 4 route days, 14 automation rules, 6 products enriched. Auto-schedule OFF for every region. |
| Env added | `CRON_SECRET` (generated, never recorded here — `vercel env pull` if you need it), `APP_BASE_URL`. |
| Domain moved | `ops.tlmbg.co` force-moved off `leopard-mark-ops` onto `leopard-mark-order-app` and aliased to the production deployment. |
| Verified live | `/` host-rewrites to `/ops` and gates to login; `/admin/login` 200; a wrong-PIN login returns a clean `CredentialsSignin` rather than a 500, which proves Neon is reachable through the domain. |

**Untouched, deliberately.** `orders.tlmbg.co` (rep app), `bol.tlmbg.co`,
`inventory.tlmbg.co` and `ach.tlmbg.co` still point at their own projects, per
§2 rule 1's "change their DNS last, after acceptance". The old
`leopard-mark-ops` project is still deployed, now reachable only at
`leopard-mark-ops.vercel.app`, so reverting is a one-command domain move back.

### Real data — imported 2026-09-02

The hub was deployed and connected but **empty**, which is the same as broken:
108 accounts at stage ① and nothing else. Reps' orders have always landed in the
spreadsheet via Apps Script, and no order had ever been written to Postgres.

Three read-only importers close that. All use the legacy Apps Script endpoints,
which take no shared secret, and **none writes a cell back to the master file** —
`scripts/backfill-sheet-orders.ts` does the same job but stamps an Order ID into
every row, which the ground rule says to do against a copy.

| Script | Result |
|---|---|
| `import-sku-catalog.ts` | 21 SKUs from the SKU Master tab (was 6). 15 created, 6 enriched. Seven unpriced ones (tap handles, experimentals) created **inactive** — usable for stock, not sellable, because guessing a price puts wrong money on a real invoice. |
| `import-sheet-orders.ts` | **250 orders**, 199 with a mirrored invoice, 32 VOID→cancelled. |
| `migrate-inventory-from-sheet.ts` | 9 ledger events, and the §4 step 7 proof: **9/9 SKU×location pairs agree** with what inventory.tlmbg.co shows. |

The live pipeline now reads ① 17 · ② 19 ($5,247) · ⑥ 174 ($47,056) · ⑦ 25
($5,331). ③④⑤ are empty because the Sheet's history has no scheduling or
delivery record, and inventing one would put phantom movements in the ledger.

**Two mapping problems had to be solved, and both are tested:**

*Account names.* The Sheet writes Customer as `<legal entity> / <DBA>` —
"Sutro Syndicate LLC / 540 SF" — which exists in neither column on its own, so a
naive normalise matched nothing at all. `candidateNames` splits and tries each
half against both `businessName` and `legalEntity`.

*SKU codes.* The Sales tab spans several coding generations
(`TLM-SGB1AKHB01-M`, `TLM.PRO.CNT-KEG.1/2`). Until `lib/sheetSkuAlias.ts`
existed this dropped 180 of 284 orders. It refuses to guess: an ambiguous
"Experimental Hazy I" could be XHZ variant B, C or D, so that one line is
reported rather than imported. 22 tests cover the real codes and their live
frequencies.

**Still outstanding from the import:**

- ~~33 orders reference customers with no Account row~~ — **closed.**
  `import-customer-accounts.ts` refreshed from the live tab: 13 accounts created,
  106 updated, 121 total. Re-running the order import took the skipped count
  from 33 to 18 and brought in INV26277 ("La Sexy Michelada"), the spec's own
  reference invoice. Production now holds 265 orders and 203 invoices.

  The remaining 18 are customers that are genuinely not on the Customer Accounts
  tab at all — one-offs and non-retail counterparties like "Atlassian",
  "Beachwood Brewing" (a contract brewery) and "Familiar Ventures LLC / Thomas
  Gilbert" (their own entity). Creating accounts from a name alone would put
  thin, permanently-incomplete rows in the attention queue for customers who
  will never order again, so they are reported instead.
- One ledger event had a fractional case quantity (33.49 → 33). `qty` is an Int
  because a third of a case cannot be delivered; the rounding is reported, not
  silent, and is inside the parity tolerance.

### Region names mapped to delivery regions — resolved

Found while refreshing accounts, and it blocks two things:

The Customer Accounts tab writes **city-level** regions — San Francisco (52),
Los Angeles (18), North Bay (14), Orange County (11), Long Beach (9),
San Diego (3), South San Francisco, San Rafael, Arcadia — while `RouteSchedule`
is seeded with `BA` and `LA`, which match **none** of them.

Consequences: every account fails the "region → warehouse" setup check, so no
account can reach 9/9; and `auto_propose_slot` has no route day to offer, so
nothing will ever move to stage ③ on its own.

**Fixed** by `lib/deliveryRegion.ts`, which sits between the two vocabularies
rather than rewriting either. 112 of 121 accounts now resolve; the 9 that do not
have no region on the tab at all.

Neither alternative was safe. Rewriting `Account.region` to "BA" would be undone
by the next run of `import-customer-accounts.ts`, and because §5 makes Region a
bidirectional DB-owned column, a DB→Sheet write would then push "BA" into the
spreadsheet and destroy city data the sales team uses. Adding a `RouteSchedule`
row per city would assert the business runs nine routes; it runs two.

So the account keeps its city, the schedule keeps `BA`/`LA`, and one function
relates them — resolved at all four call sites (slot proposal, the Slack channel
map, and the setup checklist in both the queries layer and the accounts page).

The mapping is data-as-code, and adding a city is a one-line change. It refuses
to default: an unrecognised region yields no route days rather than guessing,
because a default would pass the setup check for an account nobody can deliver
to and book it onto a truck that does not go there. 22 tests cover every region
string in the live tab plus the near-miss cases ("Sandusky" must not match
"San ...").

One judgement call is asserted so it cannot drift silently: **San Diego rides
the LA route**, since WH-WIL is the only warehouse serving Southern California,
despite being 120 miles out. Three accounts. Changing it is one line and a
failing test.

Verified against production: Orange County → LA → Fri Sep 4 from WH-WIL;
San Francisco → BA → Tue Sep 8 from WH-SF (today is Thursday, and same-day is
never proposed, so BA correctly skips to Tuesday). `region → warehouse` has
disappeared from the accounts screen's missing-items lists, which now read
"license verified, stripe customer, ach on file" — the genuinely undone work.

Also: "R. Villanueva" appears as a sales rep on 2 accounts. The Reps tab lists
them as "Ricardo Villanueva" — the Reps tab uses full names while Customer
Accounts and Sales use initials. `salesRepId` is left unset on those two rather
than creating a duplicate Rep under the abbreviated form; which spelling is
canonical is a decision, not a fix.

### Integrations wired

`STRIPE_SECRET_KEY`, `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID`, `SLACK_CHANNEL_BA/LA`,
`APPS_SCRIPT_URL` and `INVENTORY_APPS_SCRIPT_URL` are now set in production.

Still unset, and genuinely unconfigured rather than missed: `RESEND_API_KEY` and
`RESEND_FROM_EMAIL` are **empty strings** in `.env.local` — Resend was never set
up (domain verification pending), so the customer magic-link login and the
payment-setup email cannot send anywhere yet. `STRIPE_WEBHOOK_SECRET` needs to
come from the Stripe dashboard when the webhook endpoint is registered.

### The one thing not verified

I could not log in to production: `Jack Begley`'s PIN there is the real one, not
the `1234` the local demo script sets. So the hub has been proven to route,
gate and reach the database, but **nobody has yet seen a production page
render**. Sign in at `https://ops.tlmbg.co/admin/login` and check the Command
Center. Expect it to be quiet: production has 0 orders, so the attention queue
will show the accounts-needing-setup items and the pipeline strip will read
① 108 · ②–⑦ 0.

### Cron is daily, not per-minute

Vercel rejected `* * * * *`: "Hobby accounts are limited to daily cron jobs."
§2 rule 5 asks for the reason when a limit forces a change, so:

- `after()` is now the **primary** drain (`lib/jobs/kick.ts`), fired by every
  action that enqueues work. An invoice still goes out seconds after a delivery
  is marked, which is the behaviour that matters.
- The daily cron (09:00 UTC) queues the day's wall-clock jobs with their proper
  `runAfter` and sweeps up elapsed retries.
- **Gap:** a job that fails with a 5-minute backoff waits for the next ops
  action or tomorrow's cron. Upgrade to Pro, restore `* * * * *` in
  `vercel.json`, and nothing else changes — `enqueuePeriodicJobs` is idempotent
  per calendar day.

### Integrations still unconfigured in production

The hub renders without them (no page reaches the Stripe client — verified by
tracing the import graph), but these are needed before the pipeline can complete
end to end:

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`RESEND_FROM_EMAIL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_BA`, `SLACK_CHANNEL_LA`,
`APPS_SCRIPT_URL`, `SYNC_SHARED_SECRET`.

Until they are set, the relevant jobs fail with a readable reason, retry, and
land in the dead-letter queue on `/ops/automations` — which is where an operator
can see them, rather than failing silently.

### Sessions are per-hostname

Cookies are host-scoped, so signing in at `ops.tlmbg.co` does not carry over to
`inventory.tlmbg.co` once those domains move here too. That is fine for
old-bookmark aliases but worth knowing. Sharing one session across subdomains
would mean setting a `.tlmbg.co` cookie domain, which also hands the session to
`bol.tlmbg.co` where `docs_only` users live — a deliberate decision, not made.

### Pre-existing lint error

`app/page.tsx` (main's file, restored unchanged by the merge) trips
`react-hooks/set-state-in-effect`. It predates this work and does not block the
build, so it was left alone rather than edited mid-cutover.

---

## Before deploying

1. `prisma migrate deploy` against Neon. The pending
   `20260831230000_add_stripe_billing_and_inventory` (pre-existing) applies
   first. **This build was never pointed at the Neon database.**
2. Set `CRON_SECRET`, or `/api/cron/jobs` returns 503 in production by design.
3. Add the four hostnames to this Vercel project. Move DNS **last**, after
   acceptance — the old projects stay deployed so a rollback is a DNS revert.
4. Run the §4 parity check before retiring `inventory.tlmbg.co`.
5. Parallel-run the Sheet mirror against a **copy** of the master spreadsheet
   until P8, per the original prompt's ground rule.
