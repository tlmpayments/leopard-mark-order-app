# Claude Code Build Prompt — Leopard Mark Ops Platform (Orders + Inventory + BOL + Billing, unified)

> **How to use this file.** Open a fresh Claude Code session in `~/Downloads/TheLeopardMark-OrderApp` and paste this whole document. Start in **plan mode**. This prompt *extends* — it does not replace — `docs/CLAUDE-CODE-BUILD-PROMPT.md` and the two saved plans (`~/.claude/plans/jazzy-pondering-rivest.md`, `~/.claude/plans/greedy-snuggling-clarke.md`). Where this document and those disagree, **this document wins**, because it reflects decisions made on 2026‑09‑02. Where this document is silent, they still apply (especially the compliance constraints in §1 of the original prompt — those are untouched and non‑negotiable).
>
> A companion file, `docs/ops-hub-mockup.html`, is the visual spec for every screen in §8. Open it in a browser and click through it before writing any UI. Reproduce its layout, hierarchy, states and copy; you may improve it, but do not flatten it into a generic admin template.

---

## 0. The one‑paragraph brief

The Leopard Mark Brewing Co. sells kegs and cases to licensed retail accounts. Today the work is split across four Vercel projects that share one Google Sheet ("TLM Distribution Master File", ID `1AjH3tCpLYbAuSD-yZtZgmGFrejtAm_XXF0-GQXJ2cNc`): `orders.tlmbg.co` (rep ordering + a Postgres replatform in progress), `inventory.tlmbg.co` (event‑sourced stock ledger + BOL generation), `bol.tlmbg.co` (paperwork‑only BOL/Delivery Receipt maker), `ach.tlmbg.co` (Stripe ACH setup links), and a card‑grid hub at `ops.tlmbg.co`. **Merge all of it into this repo as one Next.js application with Postgres as system of record**, keep the Sheet as a live mirror, turn `ops.tlmbg.co` into a real operations hub that shows every order moving through a seven‑stage pipeline, and automate the hand‑offs between stages — most importantly, **Stripe invoices sent automatically to the account's billing email, starting with a new account's first order**.

The pipeline every order is tracked through, exactly as ops will see it:

```
① Account set up → ② New order → ③ Needs scheduling → ④ Delivery scheduled → ⑤ Delivered (BOL issued) → ⑥ Invoiced → ⑦ Paid
```

Stage ⑤ is one stage more than the user originally listed. It exists because the invoice due date is legally "Net 30 **from delivery**" (Cal. B&P § 25509 — see the footer of every real invoice, e.g. INV26277) and because delivery is the moment inventory actually leaves a warehouse and keg custody transfers. Invoicing before delivery would produce wrong due dates and wrong stock. Keep it.

---

## 1. Read these before you plan (real paths, real state)

### 1.1 This repo — `TheLeopardMark-OrderApp`

| Path | What it is | State |
|---|---|---|
| `public/rep-app/` (`index.html`, `assets/js/app.js`, `products.js`, `customers.js`, `config.js`) | The legacy static PWA reps use daily. PIN login, home/stats, Place Order, Add Account, My Accounts, Admin: All Orders, invoice PDF generator. | **Live. Never break it.** |
| `apps-script/Code.gs` (+ `clasp-project/`) | The legacy backend: Apps Script web app bound to the Sheet. Actions include `login/reps/setPin/stats/customerOrders/lastOrder/allOrders/order/invoiceDetail/customers/addCustomer/updateCustomer/syncOrder/allSalesRows/writeOrderIds`. `handleOrder` already: assigns `nextInvoiceNumber`, picks `warehouseForRegion(region)` as Inventory Source, detects **first order** via a `First Order Sent` column, posts to Slack (`SLACK_WEBHOOK_URL_BA` / `_LA` by region) with `:tada: FIRST ORDER` vs `:beer: NEW ORDER`. | Live. |
| `prisma/schema.prisma` | Postgres schema (Neon). Models: `Rep, Account, Contact, Consent, Product, AccountPricing, Order, OrderLine, Invoice, Message, AiInterpretation, OrderEvent, State, SyncLog, InventorySnapshot, BreweryMovementEvent, Auth*`. `OrderStatus = draft \| pending_confirmation \| confirmed \| scheduled \| fulfilled \| cancelled \| rejected \| expired`. `Account` already has `stripeCustomerId`, `stripeDefaultPaymentMethod`, `stripeSetupLinkSentAt`, `approvalStatus`, `licenseStatus/Expiry`, `creditHold`, `terms`, `paymentMethod`, `sheetRowRef`. `Invoice` mirrors Stripe's status. | Migrated through `20260831230000_add_stripe_billing_and_inventory`. **No real Order rows in production yet** — reps' orders still land in the Sheet via Code.gs. |
| `lib/sheetSync.ts`, `lib/sheetColumns.ts` | Phase 2: DB→Sheet (`syncOrderToSheet` → Code.gs `handleSyncOrder`) and Sheet→DB webhook (`app/api/sheet-sync/webhook/route.ts`, fed by Code.gs `onEdit`). `DB_OWNED_COLUMNS` / `SHEET_OWNED_COLUMNS` encode the conflict rule. Adding a synced column is a "5‑place coordinated change" — respect that. | Built, tested (`__tests__/sheet-sync-*.test.ts`), adversarially reviewed. |
| `lib/stripeCustomer.ts` | `ensureStripeCustomer(accountId)` (single choke‑point; never create Stripe Customers elsewhere) and `sendPaymentSetupLink(accountId)` (Checkout Session in `setup` mode → emails the link). | Built; wired to admin approval only. |
| `lib/stripeBilling.ts` | `issueOrderInvoice(orderId)` — creates invoice + items from `OrderLine.lineTotal`, finalizes, `sendInvoice` when no default payment method, writes `Invoice` row, `local_error` fallback + `retryFailedInvoices()` for cron. `termsToDays` mirrors Code.gs. | Built, **not yet called from any live order path**. |
| `app/api/webhooks/stripe/route.ts` | Handles `customer.updated`, `setup_intent.succeeded`, `invoice.finalized/paid/payment_failed/voided`. | Built. |
| `app/admin/`, `app/customer/`, `auth.ts`, `proxy.ts` (Next 16's middleware) | Admin approval UI (approve → ensureStripeCustomer + setup link), customer portal login/signup (magic link via Resend — domain verification pending), NextAuth v5 beta. | Built, thin. |
| `scripts/` | `import-foundation-data.ts`, `backfill-sheet-orders.ts` (Invoice # → ULID Order ID grouping), `import-inventory-snapshot.ts`, `import-ttb-movements.ts`. | One‑shot tools. |
| `.env.local` | `DATABASE_URL*`, `AUTH_SECRET`, `STRIPE_SECRET_KEY`, `RESEND_*`, `SLACK_BOT_TOKEN/TEAM_ID/CHANNEL_BA/CHANNEL_LA`, `TWILIO_*`. | Present, gitignored. Never commit. |
| Stack | Next 16.3 App Router, React 19, Prisma 7 (`prisma-client` generator → `app/generated/prisma`), `@prisma/adapter-pg`, NextAuth 5 beta, Stripe SDK 22, Vitest. Read `AGENTS.md` → `node_modules/next/dist/docs/` first; this Next.js differs from training data. | |

### 1.2 `~/Downloads/TheLeopardMark-Inventory` (→ becomes part of this repo)

- Static PWA + `apps-script/Code.gs`. **Its backend already points at the same master spreadsheet** (`MASTER_SS_ID = 1AjH3…`). Tabs it *owns*: `SKU Master`, `Location Details`, `BOLs`, `Event Detail`, `Commodities`, `BOL Maker Log`. Tabs it *reads*: `Location Information`, `Production`, `Customer Accounts`. Tab it *appends to* (never rewrites): `Inventory Ledger`.
- Event‑sourced: `EVENT_TYPES = BREW, INCOMING, TRANSFER, DELIVERY, RETURN, SAMPLE, DESTRUCTION, LOSS`; `BOL_TYPES = TRANSFER, DELIVERY, INCOMING, RETURN`; sinks `DELIVERY, SAMPLE, DESTRUCTION, LOSS`. Stock is netted on read per (SKU, Location). BOL numbers are `BOL-<fromLocation>-<yymmdd>-<seq>`, derived by scanning the ledger (no lock — same race Code.gs has).
- Actions: `locations, skus, commodities, accounts, bolLogList/Get, saveBolLog, updateLocation, updateEvent, stock, dashboard, events, bol, brews, renameBol, addEvent`.
- `SKU_HEADER = SKU, Brand, Product, PackageType, IsKeg, Deposit, ReorderThreshold, Active, Price, WeightPerUnit`. **SKU codes are identical to `Product.skuCode` here** (e.g. `CNT1AKSB01`, `SGB1AKHB01`, `GSP1AKSB01`, `CNT-TAPHANDLE`, `SGB-TAPHANDLE`, experimental `XHZ*/XVN*`). Brands: CNT Cantinesca, SGB Sunlight Groove Bay Area, SGS Sunlight Groove SoCal, GSP Giro Splendido.
- `data/Locations.csv`: `LocationID, Name, Type(Brewery|Warehouse), City, State, Address, Lat, Lng, Active` — 7 breweries (Richmond, Huntington Beach, San Diego CA; Northglenn CO; Framingham MA; Garnerville NY; Blanco TX) + 4 warehouses (Benicia, San Francisco, Wilmington, Windsor CA). "Available for delivery" = Warehouse locations only.
- `assets/js/bol.js`: `renderBolHtml / renderDeliveryReceiptHtml / renderFreightBolHtml` — the print renderer. Delivery receipts show **weight**, not price (commit 79a0f57).
- Known gaps its README names: no per‑user location scoping; **keg deposit/custody balances per account not tracked** (SKU Master has a `Deposit` column ready); BOL sequence needs a real counter.

### 1.3 `~/Downloads/TheLeopardMark-BOL` (→ becomes a route here)

Paperwork‑only generator for people who need a printable Delivery Receipt or Straight BOL without the inventory login ("Daniel included"). Read‑only against the same Apps Script; mints its own editable `DR-<yymmdd>-####` / `BOL-<yymmdd>-####` numbers because it can't touch the ledger. `bol.js` is a verbatim copy kept in sync by hand. Has a "Previously Generated" log (`BOL Maker Log` tab) and a batch print queue (≤100 docs). **The user need is real (printing without logging stock); the two‑numbering‑schemes situation is the problem to remove.**

### 1.4 `~/Downloads/TheLeopardMark-Ops` and `~/Downloads/TheLeopardMark`

- `TheLeopardMark-Ops/index.html` — the current `ops.tlmbg.co`: a card grid linking to Inventory, Orders, BOL Maker, ACH Onboarding. Replace it.
- `TheLeopardMark/` — an undeployed **Operations Hub prototype** (network map, alerts, production, integrations, "Ask Mark" AI panel) with the brand design system in `assets/css/app.css`: surfaces `#050b18 → #182d4e`, silver hairlines, chrome wordmark; categorical series `#3987e5 blue, #d95926 orange, #199e70 aqua, #c98500 yellow, #d55181 magenta` (validated colorblind‑safe against `#0d1b33`); status colors reserved. **Borrow its visual language and its "Alerts ranked by consequence, with an owner" idea; do not port its mock EKOS/VIP data.**

### 1.5 The real invoice (ground truth for §6)

`INV26277`, La Sexy Michelada, 8/31/2026: header (company, `(707) 261-0200`, `ar@theleopardmark.com`, Sales Rep), `Invoice / PO Date / Delivery Date / Payment Terms: Net 30 / Due Date`, Ship To + Bill To + License Number, line table `Item | Item Number | UPC | Quantity | Unit Price | Total`, then **`Keg Deposit` (+$35 per keg) and `Keg Deposit Returned` (−$35 per empty picked up)** as separate lines, `TAX: Exempt (0.0000%)`, footer: "For new purchase orders, please email orders@theleopardmark.com", deposit clause, and "Terms: Net 30 from delivery (Cal. B&P Code § 25509) … paid via seller‑initiated EFT per § 25509.1." The Stripe invoice must carry every one of these facts (see §6.3).

---

## 2. Target architecture (one app, four hostnames)

```
                     ┌──────────────────────────────────────────────────────────────┐
  orders.tlmbg.co ──►│  Next.js 16 (this repo, Vercel project TheLeopardMark-OrderApp) │
  ops.tlmbg.co    ──►│  proxy.ts: host → route-group rewrite                          │
  inventory.tlmbg.co►│  /(rep)      public/rep-app PWA, then app/rep (Phase R)        │
  bol.tlmbg.co    ──►│  /(portal)   app/customer  (self-serve)                        │
  ach.tlmbg.co    ──►│  /(ops)      app/ops       (THE HUB — §8)                      │
                     │  /(docs)     app/docs      (BOL/DR maker, no ledger write)     │
                     │  /api/…      webhooks: stripe, twilio, sheet-sync, slack       │
                     │  lib/pipeline, lib/inventory, lib/bol, lib/billing, lib/jobs   │
                     └───────┬─────────────────┬────────────────────┬─────────────────┘
                             ▼                 ▼                    ▼
                     Postgres (Neon)     Google Sheet mirror     Stripe · Slack · Resend · Twilio
                     SYSTEM OF RECORD    (Sales, Customer Accounts, Inventory Ledger, BOLs …)
```

Rules:

1. **Host routing in `proxy.ts`.** Map `ops.tlmbg.co → /ops`, `inventory.tlmbg.co → /ops/inventory`, `bol.tlmbg.co → /docs`, `ach.tlmbg.co → /ops/billing/setup-links`. Keep `orders.tlmbg.co` serving `public/rep-app/` at `/rep-app/` (or `/`) exactly as today until Phase R cutover. Add all domains to the one Vercel project; leave the old projects deployed but change their DNS last, after acceptance.
2. **Postgres is system of record for everything**, including inventory and BOLs (this is a change from the "read‑only inventory dashboard" decision in `greedy-snuggling-clarke.md` Phase 11 — `InventorySnapshot`/`BreweryMovementEvent` stay as import mirrors for third‑party stock, but *Leopard Mark's own* ledger moves into first‑class tables per §4).
3. **The Sheet stays a live mirror**, extended to the inventory tabs with the same ownership discipline as `lib/sheetColumns.ts`. DB→Sheet writes go through Code.gs actions under a `LockService` lock; Sheet→DB via `onEdit` webhook + nightly reconciliation. Never let a Sheet outage fail a user action (the `syncOrderToSheet` philosophy).
4. **Every stage transition is an `OrderEvent`** (append‑only) and every automation run is a `JobRun`. The hub renders *from those tables*, so "what happened and who did it" is never reconstructed from logs.
5. **Jobs:** use a Postgres‑backed job table (`lib/jobs`) driven by Vercel Cron (`vercel.json`) every minute for due jobs + on‑demand `after()`/`waitUntil` for immediate follow‑ups. Do not add Inngest/Trigger.dev unless you hit a limit; state the reason if you do. Every job has an idempotency key, max attempts, and a dead‑letter state visible in the hub (§8.9).
6. **Roles** (NextAuth, extend `Rep.role` → `UserRole = admin | ops | warehouse | rep | docs_only`). Reps keep 4‑digit PIN login (bcrypt in `Rep.pinHash`) via `lib/repAuth.ts`. Ops/admin get magic‑link (Resend) *and* PIN. `docs_only` exists so "Daniel" can print BOLs at `bol.tlmbg.co` with a PIN and nothing else. Per‑user **location scoping** (`UserLocation` join table) closes the Inventory README's gap.

---

## 3. The order pipeline — precise semantics

Do not add seven values to `OrderStatus`. Keep `OrderStatus` as the *contract* lifecycle (the compliance gate `draft → pending_confirmation → confirmed` must stay exactly as tested in `__tests__/confirmation-gate-adjacency.test.ts`). Add fulfillment and billing facts as columns/relations, and **derive** the stage in one pure function with exhaustive tests:

```ts
// lib/pipeline.ts
export type PipelineStage =
  | "account_setup"        // ① account exists, first order not yet placeable/placed
  | "new_order"            // ② confirmed, no delivery scheduled, ops hasn't triaged
  | "needs_scheduling"     // ③ triaged / auto-proposed slot awaiting confirmation
  | "scheduled"            // ④ scheduledFor set, shipment planned
  | "delivered"            // ⑤ Shipment.deliveredAt set, BOL issued, ledger DELIVERY events written
  | "invoiced"             // ⑥ Invoice.status in (open, uncollectible) — sent to billing email
  | "paid"                 // ⑦ Invoice.status = paid
  | "blocked"              // any stage, with reason: license_expired | credit_hold | approval_pending | stock_short | stripe_error | sync_conflict
  | "cancelled";

export function pipelineStage(o: OrderWithRelations): { stage: PipelineStage; since: Date; blockedReason?: BlockedReason }
```

Stage facts and who/what advances them:

| Stage | Entered when | Advanced by | Automation on entry |
|---|---|---|---|
| ① Account set up | `Account` created (rep app `addCustomer`, portal signup, ops) | approval + billing email present + `stripeCustomerId` set | `ensureStripeCustomer`; if no default PM → `sendPaymentSetupLink`; Slack "new account" card; **setup checklist** computed (license #, license status, billing email, terms, payment method, Stripe customer, payment method on file, region→warehouse) |
| ② New order | `Order.status = confirmed` (rep app submit / portal confirm / SMS confirm) | ops triage or auto‑propose | `syncOrderToSheet`; Slack `NEW ORDER` / `FIRST ORDER` (port the exact Code.gs copy incl. `:tada:`); stock check against §4 `available` for `inventorySource` warehouse → `blocked:stock_short` if short; **propose delivery slot** from `RouteSchedule` (region → weekday(s) → next available ≥ account `deliveryWindow`) |
| ③ Needs scheduling | proposal exists, unconfirmed | ops accepts/edits proposal in hub (one click) or **auto‑schedule policy** on for that region | none (waiting on human) |
| ④ Delivery scheduled | `Order.scheduledFor` set → `Shipment` row created (`status=planned`, `fromLocationId` = warehouse) | warehouse marks delivered | write `Delivery (Invoice) Date` to Sheet (flip `deliveryDate` to DB‑owned per the schema comment that anticipates this); reserve stock (soft, informational); pre‑render Delivery Receipt PDF; add to that day's **print batch**; Slack per‑region "Tomorrow's deliveries" digest at 16:00 |
| ⑤ Delivered | warehouse/rep taps **Mark delivered** (hub or rep app) with optional lot #s, actual qty, empties picked up | system | mint **real sequential BOL #** (`BolSequence` row lock, format `BOL-<LocationID>-<yymmdd>-<seq>` — same as Inventory), write `InventoryEvent(DELIVERY)` per line + `RETURN` events for empties, `KegCustodyLedger` entries, write `BOL #`, `Lot #`, `MicroStar empties` to Sheet, **enqueue `issue_invoice`** |
| ⑥ Invoiced | `issueOrderInvoice` succeeds (§6) | Stripe webhook | write `Invoice #` (=`Order.invoiceNumber`, also set as Stripe `number`? — no: Stripe numbering is immutable per account; store ours in `metadata.invoiceNumber` and `custom_fields`) and `Invoice Status = Sent` to Sheet; Slack thread reply "Invoiced $X, due <date>" |
| ⑦ Paid | `invoice.paid` webhook | — | Sheet `Invoice Status = Paid`, `ACH Invoice REF #` = Stripe payment intent/charge id; Slack ✅; account `creditHold` auto‑clears if the paid invoice was the cause |

Blocked is an overlay, not a step: an order can be `scheduled` *and* `blocked:license_expired`. The hub shows the stage chip plus a red "blocked" stripe with the reason and the one action that clears it. **Never auto‑clear a compliance block** (license, credit) — a human does that, and it's logged.

`OrderEvent.eventType` vocabulary (string enum in `lib/pipeline.ts`, tested): `account.created, account.approved, account.stripe_customer_created, account.setup_link_sent, account.payment_method_added, order.confirmed, order.sheet_synced, order.slack_posted, order.stock_checked, order.slot_proposed, order.scheduled, order.rescheduled, shipment.delivered, bol.issued, inventory.events_written, invoice.issued, invoice.sent, invoice.payment_failed, invoice.paid, order.blocked, order.unblocked, order.cancelled, sync.conflict`. Each carries `actor` (existing enum) and `payloadJson` with before/after.

---

## 4. Data model changes (Prisma) — additive, migration‑safe

Add; do not rename existing models (the sync layer and tests depend on them).

```prisma
// ---- People & access ----
enum UserRole { admin ops warehouse rep docs_only }     // migrate Rep.role: admin→admin, rep→rep
model UserLocation { userId String; locationId String; @@id([userId, locationId]) }  // per-user scoping

// ---- Network ----
model Location {            // from Inventory data/Locations.csv + "Location Information" tab
  id String @id            // "BRW-RICH", "WH-BEN" …  (keep Inventory's LocationID values verbatim)
  name String; type LocationType; city String; state String; address String?; lat Float?; lng Float?
  active Boolean @default(true)
  inboundInstructions String?; outboundInstructions String?; shippingHours String?  // from "Location Details"
  sheetRowRef Int?
}
enum LocationType { brewery warehouse }
model RouteSchedule {       // "what days do we deliver where" — replaces the hardcoded rep→region map
  id String @id @default(cuid()); region String; warehouseId String; weekday Int; cutoffHour Int; active Boolean
}
model RegionSlackChannel { region String @id; channelId String }   // BA/LA today; extensible

// ---- Catalog: extend Product instead of adding a parallel Sku model ----
model Product { … existing …
  brandCode String?; packageType String?; isKeg Boolean @default(false)
  depositAmount Decimal? @db.Decimal(10,2)     // 35.00 for 1/2 & 1/6 today (from SKU Master "Deposit")
  reorderThreshold Int?; weightPerUnit Decimal? @db.Decimal(10,2); upc String?
}
model Commodity { code String @id; name String; nmfcNumber String?; notes String? }  // freight BOL commodities

// ---- Inventory (event-sourced, append-only, replaces the Apps Script Events/Inventory Ledger as SoR) ----
enum InventoryEventType { BREW INCOMING TRANSFER DELIVERY RETURN SAMPLE DESTRUCTION LOSS ADJUSTMENT }
model InventoryEvent {
  id String @id @default(cuid()); occurredAt DateTime; type InventoryEventType
  productId String; qty Int                       // positive integers; direction is implied by type+locations
  fromLocationId String?; toLocationId String?    // null = external source/sink; DELIVERY sets accountId
  accountId String?; orderLineId String?; shipmentId String?
  lotNumber String?; actorUserId String?; refNote String?; notes String?
  correctionOfId String?                          // ADJUSTMENT/reversal points at the event it corrects; never UPDATE a row
  sheetRowRef Int?; createdAt DateTime @default(now())
  @@index([productId, fromLocationId]) @@index([productId, toLocationId]) @@index([shipmentId])
}
// stock = SQL view `stock_by_location` (sum in − sum out per product×location) + `available_for_delivery` (warehouses only).
// Materialize only if a query exceeds ~200ms at real volume.

// ---- Shipments & documents ----
enum ShipmentStatus { planned in_transit delivered cancelled }
enum DocType { delivery_receipt straight_bol }
model Shipment {
  id String @id @default(cuid()); status ShipmentStatus; type InventoryEventType   // DELIVERY | TRANSFER | INCOMING | RETURN
  fromLocationId String?; toLocationId String?; accountId String?                 // DELIVERY → accountId
  orderId String? @unique                                                          // one shipment per order for now
  scheduledFor DateTime?; deliveredAt DateTime?; deliveredByUserId String?
  bolNumber String? @unique; docType DocType
  carrierName String?; carrierPhone String?; handlingUnits Int?; weightLbs Decimal?; dimensions String?; freightClass String?
  preparedBy String?; referenceNote String?; notes String?
  renderedHtml String?  // snapshot of the printed document at issue time (immutable evidence)
  sheetRowRef Int?      // row in the "BOLs" tab
}
model BolSequence { locationId String; yymmdd String; last Int; @@id([locationId, yymmdd]) }  // SELECT … FOR UPDATE
model DocumentLog {   // the BOL Maker's "Previously Generated" — paperwork with NO ledger effect
  docNumber String @id; docType DocType; date DateTime; summary String; payloadJson Json
  createdByUserId String?; shipmentId String?   // set when a doc is later "attached" to a real shipment
}

// ---- Keg custody (closes the Inventory README gap) ----
model KegCustodyEntry {
  id String @id @default(cuid()); accountId String; productId String
  delta Int                       // +n delivered, −n returned
  shipmentId String?; invoiceId String?; occurredAt DateTime; createdAt DateTime @default(now())
}
// balance per account = SUM(delta); deposit exposure = SUM(delta × Product.depositAmount)

// ---- Jobs & automation ----
enum JobStatus { queued running succeeded failed dead }
model JobRun {
  id String @id @default(cuid()); kind String; idempotencyKey String @unique; status JobStatus
  payloadJson Json; attempts Int @default(0); maxAttempts Int @default(5)
  runAfter DateTime; lastError String?; startedAt DateTime?; finishedAt DateTime?
  orderId String?; accountId String?
  @@index([status, runAfter])
}
model AutomationRule {   // the toggles in §8.9 — code reads these, never hardcodes "on"
  key String @id         // "auto_stripe_customer_on_account", "auto_send_setup_link", "auto_propose_slot", "auto_schedule_region:BA", "auto_invoice_on_delivery", "slack_daily_digest" …
  enabled Boolean; configJson Json?; updatedByUserId String?; updatedAt DateTime @updatedAt
}

// ---- Order additions ----
model Order { … existing …
  deliveredAt DateTime?; shipment Shipment?; expectedEmptyKegs Int?; tapHandleRequested Boolean?
  blockedReason String?; blockedAt DateTime?; blockedByUserId String?
}
model Invoice { … existing …
  invoiceNumber String? @unique   // our INV##### (copy of Order.invoiceNumber at issue time)
  pdfUrl String?; depositAmount Decimal? ; depositCreditAmount Decimal?
}
```

Migration/seed steps (write as `scripts/migrate-inventory-from-sheet.ts`, idempotent, dry‑run flag):

1. `Location` ← `data/Locations.csv` merged with the `Location Information` + `Location Details` tabs.
2. `Product` enrichment ← `SKU Master` tab (join on `skuCode`; create any SKU missing in `Product`, e.g. `GSP*`, tap handles, `XHZ*` as `active=false` where the tab says so).
3. `Commodity` ← `Commodities` tab.
4. `InventoryEvent` ← every row of `Inventory Ledger` (+ `Event Detail` sidecar for actor/unit price), preserving `EventID` in `refNote` and `sheetRowRef`; `Shipment` ← `BOLs` tab rows, linked by BOL #.
5. `DocumentLog` ← `BOL Maker Log`.
6. `KegCustodyEntry` backfill from historical `DELIVERY`/`RETURN` events for keg SKUs, plus Sales‑tab `MicroStar 1/2 Empty` / `MicroStar 1/6 Empty` columns. Print the resulting per‑account balances for the user to sanity‑check *before* they show in the hub.
7. Prove `stock_by_location` equals what `inventory.tlmbg.co`'s dashboard shows today, SKU by SKU, and paste the diff in the PR.

---

## 5. Sheet mirror — extended ownership table

Extend `lib/sheetColumns.ts` (and its test) into a per‑tab registry. Ownership after this build:

| Tab | DB‑owned (DB writes, Sheet edits are conflicts) | Sheet‑owned (ops edits flow to DB) |
|---|---|---|
| **Sales** | existing DB‑owned set + `Delivery (Invoice) Date`, `BOL #`, `Lot #`, `Invoice Status`, `ACH Invoice REF #`, `MicroStar 1/2 Empty`, `MicroStar 1/6 Empty` **once Phase P4 ships** (the system now produces them). Until then unchanged. | `Notes` (existing exception), tap‑handle columns, anything not listed |
| **Customer Accounts** | `Business Name, Sales Person, Region, Alc. License #, Legal Name, Ordering Contact, Phone, Ordering Contact Email, Delivery Address/Instructions/Window, Payment Method, Billing Contact Email, Terms, Billing Address, Tap Handle Requested, First Order Sent` — bidirectional with **last‑write‑wins + conflict log** (ops legitimately edits these) | — |
| **Inventory Ledger** | all columns (append‑only from DB). A row added by hand in the Sheet is imported by the nightly reconcile as an `InventoryEvent` with `actor=ops` and flagged in the hub for review. | — |
| **BOLs**, **SKU Master**, **Location Details**, **Commodities**, **BOL Maker Log** | DB‑owned mirrors; Sheet edits raise `sync.conflict` | — |
| **Reps** | DB‑owned (PINs are hashed in DB; the Sheet keeps names/roles only — stop mirroring plaintext PINs) | — |

Keep the existing `Order ID` column discipline. Add a `Shipment ID` column to `BOLs` and `Inventory Ledger`. Every write to the Sheet is idempotent on (entity id, tab).

---

## 6. Stripe invoicing — the exact behavior

### 6.1 When
`issue_invoice` job is enqueued on **⑤ Delivered** (not on order confirmation). Rule `auto_invoice_on_delivery` (default **on**) governs it; when off, the hub shows an "Issue invoice" button instead. A delivery can also be invoiced manually from the hub at any time. Idempotency key: `invoice:${orderId}`; `issueOrderInvoice` already short‑circuits on an existing `Invoice` row.

### 6.2 To whom
Resolve the **billing email** in this order and record which was used in `OrderEvent.payload`: `Account.billingContactEmail` (new column — import from Customer Accounts "Billing Contact Email") → the ordering `Contact.email` → none. If none: create the invoice as `send_invoice` but **do not send**; mark `blocked:missing_billing_email` and surface in the hub's attention queue with an inline "add billing email and send" action. Set the Stripe Customer's `email` to the billing email via `ensureStripeCustomer` (update if changed; still the single choke‑point).

### 6.3 What the invoice contains (match INV26277)
- One `invoiceItem` per `OrderLine`: description `"${productName} ${formatLabel}"` (e.g. `Cantinesca 1/6 Barrel Keg (5.16 gal)`), `quantity`, `amount = lineTotal` in cents (keep the current rounding approach), metadata `{ skuCode, orderLineId, lotNumber }`.
- One **`Keg Deposit`** line per keg SKU line: `quantity = qty`, `unit_amount = Product.depositAmount`.
- One **`Keg Deposit Returned`** line per empty picked up at delivery (from `Shipment` empties / `KegCustodyEntry` with `delta<0` for this shipment): negative amount. Stripe allows negative invoice items; the net cannot go below zero — if it would, carry the remainder as a Stripe **customer balance credit** and say so on the invoice footer.
- Tax: `automatic_tax: false`, and a footer line `TAX: Exempt (0.0000%)` (wholesale alcohol to licensed retailers; confirm with the user that every account is exempt before hardcoding — otherwise use `Account.taxExempt`).
- `collection_method`: `charge_automatically` when `stripeDefaultPaymentMethod` (ACH) is on file, else `send_invoice` with `days_until_due = termsToDays(account.terms)` **counted from `deliveredAt`**, not from creation — compute `due_date` explicitly.
- `custom_fields`: `PO Date`, `Delivery Date`, `Sales Rep`, `License Number`, `Invoice #` (ours, `INV#####` from `Order.invoiceNumber`). `metadata`: `orderId, invoiceNumber, bolNumber, region, salesRep`.
- `footer`: the two legal sentences verbatim from §1.5. `description`: "For new purchase orders, please email orders@theleopardmark.com".
- Shipping address = delivery address (`shipping_details`), billing = billing address or same.
- `payment_settings.payment_method_types = ["us_bank_account", "card"]` (ACH first — matches `ach.tlmbg.co` and § 25509.1 EFT language).
- Store `hosted_invoice_url`, `invoice_pdf`, our `invoiceNumber` on the `Invoice` row.

### 6.4 First order of a new account
When `pipelineStage` was `account_setup` before this order (i.e. `hasSentFirstOrder` false / `Account.firstOrderAt` null): (a) set `Account.firstOrderAt`, (b) mirror `First Order Sent = TRUE` to the Sheet exactly as Code.gs does, (c) Slack `:tada: FIRST ORDER` with the existing copy, (d) at ⑥, send the invoice **and** — if no payment method is on file — include the payment‑setup link (from `sendPaymentSetupLink`, reusing an unexpired session) in the same email flow so the customer sets up ACH while paying. Never send two setup links within 7 days.

### 6.5 Failures
Any Stripe failure → `Invoice.status = local_error` (existing behavior), `JobRun.failed` with backoff (1m, 5m, 30m, 2h, 12h), hub attention item, Slack `:warning:` after the 3rd failure. `retryFailedInvoices()` moves to the jobs runner. `invoice.payment_failed` → `blocked:payment_failed` overlay + Slack; **do not** set `creditHold` automatically (a human decides).

### 6.6 Webhooks
Extend `app/api/webhooks/stripe/route.ts`: on `invoice.paid` also write Sheet `Invoice Status = Paid` + `ACH Invoice REF #`, append `OrderEvent invoice.paid`, reply in the order's Slack thread. Verify signatures (already), and make handlers idempotent on `event.id` (store in a `StripeEvent` table).

---

## 7. Automations catalogue (each is a rule row in `AutomationRule`, a job kind in `lib/jobs`, and a card in §8.9)

| Key | Trigger | Does | Default |
|---|---|---|---|
| `auto_stripe_customer_on_account` | `account.created` / approved | `ensureStripeCustomer` | on |
| `auto_send_setup_link` | Stripe customer created w/o PM | `sendPaymentSetupLink` to billing email | on |
| `sheet_sync_order` | `order.confirmed` | `syncOrderToSheet` | on (not toggleable) |
| `slack_new_order` | `order.confirmed` | port Code.gs Slack copy, per‑region channel, keep thread `ts` on the Order for later replies | on |
| `stock_check_on_confirm` | `order.confirmed` | compare lines vs `available_for_delivery` at `inventorySource`; block if short | on |
| `auto_propose_slot` | `order.confirmed` & not blocked | next `RouteSchedule` day for region respecting cutoff & account window | on |
| `auto_schedule_region:<R>` | slot proposed | accept proposal without human | **off** per region (user turns on when trusted) |
| `delivery_digest` | cron 16:00 PT | Slack per region: tomorrow's deliveries + print‑batch link | on |
| `auto_invoice_on_delivery` | `shipment.delivered` | §6 | on |
| `invoice_reminder` | cron daily | Stripe handles dunning for `send_invoice`; we post a Slack summary of >7 days overdue | on |
| `reorder_alert` | after any `InventoryEvent` | SKU×warehouse below `reorderThreshold` → Slack `#inventory` + hub | on |
| `keg_custody_nudge` | cron weekly | accounts holding kegs > 60 days without a return → rep DM | off |
| `sheet_reconcile` | cron 02:00 | full diff Sheet↔DB per tab; conflicts to hub | on |
| `sms_*` / `ai_parse` | existing plans | unchanged | per original prompt |

Every run: `JobRun` row, duration, outcome, link to the order/account, retry button in the hub.

---

## 8. The Ops Hub — `ops.tlmbg.co` (`app/ops/…`)

**Visual spec is `docs/ops-hub-mockup.html`.** Design tokens come from `public/rep-app/assets/css/app.css` (`--navy-950…500`, `--silver`, `--accent #3987e5`, `--good #199e70`, `--warn #c98500`) plus the prototype's series palette and `--serious #d95926`. Brand fonts: `Bowery Lane` (display), `Tomato Grotesk` (body), `Bogart` (serif accents) from `public/rep-app/assets/fonts/` — the mockup falls back to Barlow Condensed/Barlow/IBM Plex Mono because it cannot ship the licensed files; swap in the brand faces. Dark‑first, information‑dense, one accent, status colors reserved for status. No emoji as UI. Tabular numerals everywhere digits align. Keyboard: `/` focuses search, `g o` orders, `g a` accounts, `g i` inventory, `esc` closes drawers.

Layout: 232px left rail (crest + "Ops"), top bar with **global search** (accounts, orders, invoice #, BOL #, lot #), environment health chips (Sheet sync · Stripe · Slack · Jobs — green/amber/red with last‑success time), user menu. Content area max 1440px. Right‑side **drawer** for detail views so the list never loses its place.

### 8.1 Command Center (`/ops`)
- **Attention queue** first (not KPIs): ranked cards — blocked orders, invoices failing, unknown SMS senders, sync conflicts, stock shorts, unmatched Sheet rows — each with an owner (rep/ops/warehouse), age, and *one* primary action. Empty state: "Nothing needs you. 14 orders are moving on their own."
- **Pipeline strip**: seven stage columns with counts and $ value; click a column → filtered Orders board. Stage chips are a sequential blue→white ramp (progress), blocked = `--serious` stripe.
- **Today**: deliveries scheduled today by region with warehouse, driver/carrier, print‑batch button; invoices going out today; expected payments.
- **KPI row** (below the fold, 5 tiles, sparkline 30d): orders this week, $ invoiced MTD, $ collected MTD, avg confirm→delivered days, kegs out in trade.
- **Live activity** feed from `OrderEvent`/`JobRun` (actor avatars: rep/ops/system/ai/customer), filterable.
- **Automation health**: each rule with last run, success rate 7d, toggle (admin only).

### 8.2 Orders (`/ops/orders`) — board + table
- Toggle **Board** (Kanban, one column per stage, cards: account, region badge, lines summary "2× ½bbl CNT · 1× case SGB", $ total, rep, age in stage, blocked stripe) and **Table** (sortable, saved filters: region, rep, stage, blocked, channel `rep_app|portal|sms`, date range). Drag a card from ③ to ④ → schedule dialog (date from route days, warehouse, carrier). Bulk: schedule, print receipts, issue invoices.

### 8.3 Order detail (drawer or `/ops/orders/[id]`)
- Header: account, `INV26277` style number, channel icon, stage chip, blocked reason, $ total.
- **Stage timeline** (vertical, seven nodes): timestamp, actor, and the artifact each produced — Sheet row link (opens the Sales tab at the row), Slack thread link, Delivery Receipt PDF, BOL #, Stripe hosted invoice, payment ref. Future stages render hollow with "what will happen next" copy (e.g. "Invoice will send automatically when marked delivered — Net 30 from delivery").
- **Lines** table with lot #, unit price, line total, deposit; **Shipment** block (from warehouse, scheduled, carrier, handling units, weight — computed from `weightPerUnit`); **Billing** block (billing email used, collection method, due date, amount paid); **Sheet sync** block (last DB→Sheet, last Sheet→DB, conflicts with a "Sheet wins / DB wins" resolver for ops); **Audit** (raw `OrderEvent` list, SMS transcript + AI interpretation when channel=sms).
- Actions (role‑gated, every one writes an `OrderEvent`): Schedule / Reschedule · Mark delivered (lot #s, empties, actual qty) · Print Delivery Receipt · Issue invoice now · Resend invoice · Record manual payment (check/EFT with ref) · Block/Unblock with reason · Cancel (before ⑤ only) · Reply in Slack.

### 8.4 Accounts (`/ops/accounts`)
- List with **setup checklist progress** (license #, license status/expiry, region→warehouse, billing email, terms, payment method, Stripe customer, PM on file, first order) as a 9‑segment bar; filters: pending approval, incomplete setup, credit hold, license expiring ≤60d, holding kegs.
- Detail: contacts (authorized SMS senders flagged), delivery info & window, pricing overrides (`AccountPricing`), **keg custody** (balance by SKU, deposit exposure $, last return date), order history with stages, invoices with aging, Stripe customer link, "Send payment setup link" (the whole of `ach.tlmbg.co`), approve/reject (from `app/admin`).

### 8.5 Deliveries (`/ops/deliveries`)
- Week view by region (BA / LA / others), columns = route days from `RouteSchedule`, cards = shipments; unscheduled orders sit in a left tray to drag in. Day header shows warehouse stock sufficiency and total weight/handling units. **Print batch** for a day → one PDF of Delivery Receipts (port `renderDeliveryReceiptHtml`). **Mark delivered** inline (also available in the rep app in Phase R).

### 8.6 Inventory (`/ops/inventory`) — supersedes `inventory.tlmbg.co`
- Tabs: **Stock** (SKU × location matrix, available‑for‑delivery highlight, thresholds, reorder alerts), **Ledger** (events, filters, correction = new ADJUSTMENT event, never edit), **Log movement** (BREW/INCOMING/TRANSFER/RETURN/SAMPLE/DESTRUCTION/LOSS with the same required fields as today; shipment types produce a `Shipment` + BOL immediately), **Brews** (read from `Production` tab as today), **Facilities** (locations, hours, instructions; per‑user scoping admin), **Keg custody** (network view: kegs in trade by account).

### 8.7 Documents (`/ops/documents` and `bol.tlmbg.co → /docs`)
- Two modes, clearly labeled: **Paperwork only** (exactly what `bol.tlmbg.co` does today: DR/BOL from the same form, `DR-/BOL-<yymmdd>-####` numbers, saved to `DocumentLog`, no stock effect — available to `docs_only`) and **Attach to shipment** (pick a planned shipment → the document gets the real BOL # and, on print, offers "Mark delivered now"). Batch queue ≤100. `renderBolHtml` etc. move to `lib/bol/render.ts` and are used by both — **one renderer, no more manual copy.** Previously Generated list with edit/regenerate.

### 8.8 Billing (`/ops/billing`) — Stripe as the ledger, hub as the cockpit
- Invoices table (Stripe status, our #, account, due, days overdue, collection method, hosted link), aging buckets, failed/`local_error` with retry, "Record payment" for off‑Stripe EFT/checks (creates a Stripe out‑of‑band payment so Stripe stays truthful), payment setup links sent/completed, payouts summary (read from Stripe Balance).

### 8.9 Automations (`/ops/automations`)
- Rules from §7 as cards: toggle, config (per‑region auto‑schedule, cutoff hours, digest time, Slack channel), last 20 runs, 7‑day success sparkline, **dead‑letter queue** with retry/discard, **Sheet sync monitor** (pending, last webhook, conflicts by tab, "run reconcile now"), Stripe webhook health (last event id/time), Slack bot health.

### 8.10 Settings (`/ops/settings`)
- Users & roles & PINs (magic link invite), location scoping, products/SKUs (deposit, threshold, weight, price), route schedule, Slack channel map, Sheet tab mapping status, feature flags for Phase R cutover.

Empty, loading, error and permission‑denied states are designed for every screen (see mockup's "States" panel). Mobile: Command Center attention queue, order detail, Mark delivered, and Documents must work on a phone (warehouse staff); the rest may be desktop‑first.

---

## 9. Rep app (`public/rep-app`) — minimal, safe changes

Phase R is the existing "rep app cutover" (point `app.js` at `/api/rep/*` implemented against Postgres, no UX change). Add only: (1) after **Add Account**, show the setup checklist status returned by the API and a "Billing email" field if missing (this is what makes ① automatic); (2) a **Mark delivered** action on an order for reps who self‑deliver (LA/SF), with lot # + empties; (3) order cards show the stage chip. Everything else stays.

---

## 10. Build phases — do them in this order, each with a PR, tests, and a demo

| Phase | Deliverable | Acceptance (must be demonstrated, not asserted) |
|---|---|---|
| **P0 Plan** | Plan‑mode plan citing files you read; confirm the §12 questions with the user | user sign‑off |
| **P1 Host routing + hub shell** | `proxy.ts` host rewrites; `app/ops` layout, rail, search, health chips, roles; `ops.tlmbg.co` domain on this project; old hub retired | log in as admin/ops/rep/docs_only; each sees the right surface; old bookmarks redirect |
| **P2 Pipeline core** | `lib/pipeline.ts`, `OrderEvent` vocabulary, `JobRun` + runner + cron, `AutomationRule`, Command Center + Orders board/table + Order detail on **existing** Order rows (backfilled via `backfill-sheet-orders.ts` in staging) | `pipelineStage` 100% branch‑tested; every stage reachable in a seeded DB; attention queue matches a hand count |
| **P3 Inventory + BOL merge** | §4 models, `scripts/migrate-inventory-from-sheet.ts`, `lib/inventory`, `lib/bol/render.ts` (one renderer), `/ops/inventory`, `/docs`, Sheet mirror for inventory tabs, `BolSequence` | stock parity diff vs `inventory.tlmbg.co` = 0; concurrent `Mark delivered` ×20 mints 20 distinct BOL #s; a DR printed from `/docs` changes no stock |
| **P4 Scheduling + delivery** | `RouteSchedule`, slot proposal, Deliveries week view, print batch, Mark delivered → ledger + custody + Sheet | end‑to‑end: confirm → propose → schedule → deliver, Sheet shows Delivery Date, BOL #, Lot #, empties; custody balance moves |
| **P5 Billing automation** | §6 in full, `/ops/billing`, webhooks idempotent, first‑order flow | Stripe **test mode**: a seeded new account's first delivered order yields a sent invoice to the billing email with deposit lines, Net 30 from delivery, our INV # in custom fields; `invoice.paid` (via Stripe CLI) flips ⑦ and Sheet status; failure path lands in dead‑letter and retries |
| **P6 Automations UI + Slack** | `/ops/automations`, rule toggles, digests, thread replies, reorder alerts, reconcile | toggling `auto_schedule_region:BA` changes behavior without deploy; Slack thread shows the full story of one order |
| **P7 Rep app R‑cutover** | §9 + `/api/rep/*` | reps' orders create Postgres Orders (channel `rep_app`) and still appear in the Sheet within seconds; `First Order Sent` semantics preserved |
| **P8 Retire satellites** | DNS for `inventory.` `bol.` `ach.` → this project; archive the other repos with a README pointer | a week of parallel run with zero conflicts; user flips DNS |

Never skip P3's parity check or P5's test‑mode demo. Use a **copy** of the master spreadsheet for every phase until P8 (the original prompt's ground rule).

---

## 11. Tests you must add (Vitest; keep the existing suite green)

- `pipeline.test.ts` — table‑driven: every (OrderStatus × scheduledFor × deliveredAt × Invoice.status × blocked) combination → expected stage; blocked overlay precedence.
- `bol-sequence.test.ts` — concurrency: N parallel mints, no duplicates, format `BOL-<Loc>-<yymmdd>-<seq>`.
- `inventory-stock.test.ts` — netting per event type; ADJUSTMENT reversal; DELIVERY sets custody +n; RETURN −n; view equals Inventory app's algorithm on the seed CSV.
- `invoice-composition.test.ts` — line/deposit/returned‑deposit items, negative‑net → customer balance, due date from `deliveredAt` + terms, custom fields, footer text exact.
- `billing-email-resolution.test.ts` — precedence and the missing‑email block.
- `first-order.test.ts` — exactly one FIRST ORDER per account across rep_app/portal/sms channels and across retries.
- `jobs.test.ts` — idempotency key dedupe, backoff schedule, dead‑letter after maxAttempts, retry from hub re‑queues.
- `sheet-ownership.test.ts` — extend `sheet-columns.test.ts` to the per‑tab registry.
- `roles.test.ts` — `docs_only` cannot reach any ledger write; `warehouse` scoped to its locations.
- Existing `confirmation-gate-adjacency.test.ts` must still pass unchanged — the pipeline never bypasses `confirmed`.

---

## 12. Ask the user before building (do not guess)

1. Region → warehouse → delivery weekdays and order cutoff hour for each region (seeds `RouteSchedule`). Which regions may auto‑schedule from day one, if any?
2. Are **all** accounts sales‑tax exempt (invoice shows `Exempt 0.0000%`)? If not, which aren't?
3. Keg deposit amounts per SKU today (`$35` on ½ and ⅙ per INV26277 — confirm for GSP/SGS and whether MicroStar kegs differ).
4. Billing email source of truth: Customer Accounts "Billing Contact Email" with fallback to ordering contact — confirm, and whether the rep app should *require* it on Add Account.
5. Should the Stripe invoice email go out the moment the warehouse marks delivered, or batch at 17:00 the same day for review? (Default: immediate, rule‑toggleable.)
6. Who are the `docs_only` users (Daniel?) and which locations should `warehouse` users see?
7. Slack: keep BA/LA order channels; add `#inventory` and `#billing`? Channel IDs.
8. Do delivery receipts keep showing weight (current) or prices? Does the customer sign on paper or on the phone (signature capture is a small add)?
9. Anything in the `TheLeopardMark` prototype (network map, "Ask Mark") you want in this hub's v1? Default: no — link to it from Settings as "Prototype".

---

## 13. Ground rules (in addition to the original prompt's §9)

- **Never break the rep app or the Sheet.** Feature‑flag every new write path; parallel‑run against a Sheet copy.
- **No second source of truth.** Slack, Sheet, Stripe and PDFs are projections of Postgres facts (Stripe is the truth for *payment state*, mirrored into `Invoice`).
- **Append, never mutate** inventory events, order events, consents, messages, job runs. Corrections are new rows.
- **One renderer** for BOL/DR documents. One `ensureStripeCustomer`. One `pipelineStage`.
- Every automation is a rule row with a toggle, a run log, and a human‑readable name in the hub. If ops can't see it, it doesn't run.
- Secrets only in env. Sign every webhook. Idempotency keys on every external write.
- Use plan mode per phase; paste the acceptance evidence (screenshots, Stripe CLI output, parity diffs) into each PR description.
