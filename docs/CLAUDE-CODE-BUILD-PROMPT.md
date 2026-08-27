# Claude Code Build Prompt — Leopard Mark Ordering Platform

> **How to use this file:** paste the whole thing into a fresh Claude Code session opened in the repo root (`~/Downloads/TheLeopardMark-OrderApp`). It's written to be handed over verbatim. Start it in **plan mode** and let it produce a plan before it writes code — this is a multi-week build, not a one-shot.

---

## 0. Context you need before writing any code

You are extending an existing project for **The Leopard Mark Brewing Co.**, a beer producer selling wholesale to licensed retail accounts across several US states.

### What exists today

The repo at `~/Downloads/TheLeopardMark-OrderApp` is a static PWA deployed to `orders.tlmbg.co` (Vercel, `CNAME` present) that **sales reps** use to place orders on behalf of accounts. Read these files before proposing anything:

- `index.html` — the whole rep app (login, home/stats, order screen)
- `assets/js/app.js` — app logic (~54KB)
- `assets/js/customers.js` — **107 accounts bundled as static JS**, exported from `TLM Distribution Master File.xlsx`
- `assets/js/products.js` — SKU catalog with prices (CNT + SGB, 3 formats each)
- `assets/js/config.js` — Apps Script web-app URL, rep→region map
- `assets/css/app.css` — navy/Ops-Hub palette
- `apps-script/Code.gs` — the entire backend (~42KB), a Google Apps Script web app writing into a shared Google Sheet
- `README.md` — read this in full; its "Known gaps / next steps" section is essentially a backlog

### The Google Sheet (critical — it stays)

Spreadsheet ID `1AjH3tCpLYbAuSD-yZtZgmGFrejtAm_XXF0-GQXJ2cNc`. Relevant tabs:

- **Sales** — one row per order line item, 24 columns:
  `Invoice # | Customer | License Number | PO Date | Delivery (Invoice) Date | Product Name | Packaging Format | Product Code | Lot # | Qty | Price (ea) | Line Total | Inventory Source | BOL # | Sales Rep | Payment Method | ACH Invoice REF # | Invoice Status | TLM Tap Handle | SGB Tap Handle | CNT Tap Handle | MicroStar 1/2 Empty | MicroStar 1/6 Empty | Notes`
- **Customer Accounts** — header row on **row 2**, 20 columns (business name, sales person, region, license #, legal name, ordering contact, phone, email, delivery address/instructions/window, payment method, billing, terms, priority, imported-to-Ekos, tap-handle-requested)
- **Reps** — `Name | PIN | Active | Role`

**This Sheet is not being retired.** Ops and accounting live in it daily; it is the company's primary organizing surface. See Section 3 for exactly how it must be kept in sync.

### What we're building

Three new things on top of the rep app:

1. A **customer-facing portal** at `orders.tlmbg.co` where licensed retail accounts self-serve reorders
2. An **SMS reorder channel** where an account texts a reorder in natural language (WhatsApp is out of scope — see Section 5.5)
3. An **AI ordering agent** that parses those texts, confirms them back, and — on confirmation — creates, schedules, and executes the order, with **Slack** as the human oversight surface

---

## 1. Non-negotiable constraints

These come from a legal/compliance review (see `Legal-Compliance-Memo.docx` in the project folder). Do not design around them or treat them as optional.

### 1.1 Two-step confirmation is mandatory

An inbound text **never** becomes a binding order on its own. The flow is always:

```
inbound message → AI parses → system replies with a plain-language summary
→ customer explicitly confirms → ONLY THEN is the order created
```

The customer's confirmation is the moment of contract formation. Model this explicitly in the schema — an order has a `status` that passes through `draft → pending_confirmation → confirmed`, and nothing downstream (invoicing, Sheet write, fulfillment) may trigger before `confirmed`. A parse alone must never be able to create a billable order. Timeouts on unconfirmed drafts (suggest 24h) expire them rather than auto-confirming.

### 1.2 Authorized-sender verification

Every inbound message must be matched against a known authorized phone number for a specific account before it is treated as an order attempt. Unknown numbers are **never** auto-processed — they get a neutral reply and are routed to a human in Slack. Support multiple authorized numbers per account (accounts have multiple staff who order).

### 1.3 License verification is separate from payment standing

An account being paid-up is **not** sufficient to accept an order. There must be an independent check that the account's alcohol retail license is current and active, and that check must be able to block an order the credit check would allow. Build `license_status` and `license_expiry` as first-class fields with their own validation gate, distinct from `credit_hold` / AR standing. Both gates must pass.

### 1.4 Complete audit trail

For every order, persist and keep linked: the raw inbound message body, the sender number, the AI's parsed interpretation (including model + prompt version), the exact confirmation summary sent, the raw confirmation reply, and timestamps for each. This is needed for state alcohol record-keeping and is the evidence base if an order is ever disputed. Never overwrite these — append-only event log.

### 1.5 Consent and opt-out

Log SMS consent per phone number: number, timestamp, the exact terms text/version they agreed to, and the channel. `STOP` must immediately and reliably opt a number out of the messaging channel without disabling the underlying account. Also handle `HELP`, and the common variants (`UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`).

### 1.6 Multi-state awareness

Accounts span several states, and alcohol distribution rules vary by state. Build a `states` config table (per-state: self-distribution volume cap, whether license verification is required pre-sale, record retention period, notes) and make ordering rules consult it, rather than hardcoding one national policy. It's fine for it to start permissive with a TODO per state — what matters is that the seam exists so counsel's answers can be dropped in without a refactor.

### 1.7 Ordering hours / scheduling

Orders confirmed outside business hours queue for the next business day rather than being dropped. Respect each account's `deliveryWindow` field where present.

---

## 2. Architecture

Replatform to a real backend. Recommended stack (deviate only with a stated reason):

- **Next.js (App Router) + TypeScript**, deployed on Vercel — matches the existing `.vercel` setup and `orders.tlmbg.co`
- **Postgres** (Vercel Postgres, Supabase, or Neon) as the **system of record**
- **Prisma** or Drizzle for schema + migrations
- **Twilio** for SMS (A2P 10DLC registered). Not WhatsApp — see Section 5.5
- **Slack** via Bolt / Events API for the ops oversight channel
- A **job queue** (Inngest, Trigger.dev, or Postgres-backed) for scheduled/deferred work — do not rely on `setTimeout` in serverless
- Auth for the customer portal: **magic link / OTP to the on-file ordering contact email or phone**, not passwords

### Repo layout

Keep the existing rep PWA working throughout. Suggested approach: move the current static app to `/legacy-rep-app` (or serve it at a path) and build the Next.js app at the root, cutting the rep app over to the new API in a later phase. **Do not break the rep app in the process — reps depend on it daily.** Confirm the migration approach in your plan before executing it.

---

## 3. Google Sheet sync (first-class requirement, not a nice-to-have)

Postgres is the system of record. The Google Sheet is a **live, continuously-updated mirror** that ops continues to work in. Both directions matter.

### 3.1 DB → Sheet (outbound)

When an order reaches `confirmed`, write its line items into the **Sales** tab in the existing 24-column format, within seconds. Match the current column semantics exactly (see `apps-script/Code.gs` `handleOrder` for how the rep app does it today):

- **Populated at order time:** `Customer, License Number, PO Date, Product Name, Packaging Format, Product Code, Qty, Price (ea), Line Total, Sales Rep, Invoice Status ("Pending"), Notes`
- **Left blank for ops/accounting:** `Invoice #, Delivery (Invoice) Date, Lot #, Inventory Source, BOL #, Payment Method, ACH Invoice REF #, tap handle columns, MicroStar empties`

Note: unlike the current rep app, the new system **should** populate `Price (ea)` and `Line Total` — prices already exist in `products.js` and the schema should carry per-account pricing. Confirm this with the user before changing the ops workflow.

### 3.2 Add an `Order ID` column

Add an `Order ID` column to the Sales tab and write a stable order-group UUID into every line of the same order. The README explicitly flags that the absence of this is what makes it impossible to reconstruct a multi-item past order for reordering. Adding it unblocks true "reorder my last order" in every channel — which is the single highest-value feature for the text channel.

### 3.3 Sheet → DB (inbound sync)

When ops fills in fulfillment/accounting columns in the Sheet — `Invoice #`, `Delivery (Invoice) Date`, `Lot #`, `BOL #`, `Invoice Status`, `Payment Method`, `ACH Invoice REF #`, `Inventory Source`, tap handles, MicroStar empties — those values must flow **back** into Postgres so the customer portal and text channel can answer "where's my order?" without anyone re-keying.

Implement via either (a) an Apps Script `onEdit` / time-driven trigger POSTing changed rows to a webhook on the Next.js app, or (b) a scheduled poll of the Sales tab diffing against last-known state. Prefer (a) for latency with (b) as a reconciliation backstop. Authenticate the webhook with a shared secret.

### 3.4 Conflict rule

State it in code and in a comment:

- **DB owns order content** — customer, products, quantities, prices, order status through `confirmed`. If the Sheet and DB disagree on these, DB wins and the sync corrects the Sheet.
- **Sheet owns fulfillment & accounting** — invoice #, delivery date, lot #, BOL #, invoice status, payment fields. If they disagree here, the Sheet wins and the sync updates the DB.

Log every sync conflict rather than resolving silently. Build the sync idempotently (an `Order ID` + line index key) so a retry never duplicates rows.

### 3.5 Customer Accounts tab

Accounts should be read from Postgres, not the bundled `customers.js` (which the README notes is a stale static export). Do a one-time import of the Customer Accounts tab into Postgres, then keep the tab synced so ops can still edit accounts there. New accounts created in the portal or by reps write to both.

---

## 4. Data model (starting point — refine in plan mode)

```
accounts            id, business_name, legal_entity, license_number, license_state,
                    license_status, license_expiry, sales_rep_id, region, address,
                    delivery_address, delivery_instructions, delivery_window,
                    payment_method, terms, credit_hold (bool), priority,
                    imported_to_ekos, lat, lng, sheet_row_ref

contacts            id, account_id, name, email, phone_e164, role,
                    is_authorized_sender (bool), created_at

consents            id, contact_id, phone_e164, channel (sms|whatsapp),
                    status (opted_in|opted_out), terms_version, terms_text_snapshot,
                    consented_at, revoked_at, source_message_id

products            id, sku_code, product_name, format_label, format_detail,
                    unit, list_price, active

account_pricing     id, account_id, product_id, price          -- per-account overrides

orders              id (uuid = Order ID in Sheet), account_id, contact_id,
                    channel (portal|sms|whatsapp|rep_app),
                    status (draft|pending_confirmation|confirmed|scheduled|
                            fulfilled|cancelled|rejected|expired),
                    submitted_at, confirmed_at, scheduled_for, sales_rep_id,
                    notes, sheet_synced_at,
                    -- fulfillment fields synced back FROM the Sheet:
                    invoice_number, delivery_date, bol_number, invoice_status,
                    payment_method, ach_ref, inventory_source

order_lines         id, order_id, product_id, qty, unit_price, line_total,
                    lot_number, line_index

messages            id, account_id, contact_id, direction (in|out), channel,
                    from_number, to_number, body_raw, provider_message_id,
                    created_at

ai_interpretations  id, message_id, order_id, model, prompt_version,
                    parsed_json, confidence, needs_human_review (bool), created_at

order_events        id, order_id, event_type, actor (customer|ai|rep|ops|system),
                    payload_json, created_at        -- append-only audit log

states              code, self_distribution_cap, requires_license_verification,
                    record_retention_years, notes

sync_log            id, direction (db_to_sheet|sheet_to_db), order_id, row_ref,
                    fields_changed, conflict (bool), created_at
```

---

## 5. The three channels

### 5.1 Customer portal (`orders.tlmbg.co`)

Reuse the existing brand system — `assets/css/app.css` palette, the Bogart/Bowery Lane/Produkt/Tomato Grotesk fonts in `assets/fonts/`, and the crest logo in `assets/icons/brand/`. It should look like the same product as the rep app.

Screens:
- **Sign in** — magic link / OTP to the on-file ordering contact
- **Home** — account name, license status badge, open orders, "Reorder last order" as the primary action
- **New order** — product cards (reuse the `products.js` structure and imagery), format + qty pickers, per-account pricing shown
- **Review & confirm** — the same binding-order language used in the text channel, with an explicit affirmative confirm control. Show the T&C and require acknowledgement on first order.
- **Order history** — with live fulfillment status pulled from the Sheet-synced fields
- **Account details** — read-only ordering contact / delivery info, with a "request a change" that pings the rep

Keep it PWA-installable (`manifest.json`, `sw.js` already exist).

### 5.2 SMS

Single message-handling pipeline, channel-agnostic at the core, with channel adapters at the edges — keep the channel abstraction even though SMS is the only channel shipping (see 5.5), so a future channel drops in without a rewrite. Twilio webhooks land at `/api/webhooks/twilio/sms`; validate Twilio signatures.

Pipeline:
1. **Ingest** — persist raw message, normalize the number to E.164
2. **Identify** — look up contact by number; unknown → neutral reply + Slack alert, stop
3. **Consent gate** — no consent on file → send the opt-in message with terms link; only after opt-in proceed
4. **Keyword handling** — `STOP`/`HELP`/`START` and variants handled before AI parsing, always
5. **Parse** — AI extracts intent (`reorder_last` | `new_order` | `status_check` | `question` | `unclear`) and, for orders, line items with product + format + qty
6. **Validate** — account standing, license status, state rules, product availability, ordering hours
7. **Confirm** — send the plain-language summary, create the order as `pending_confirmation`
8. **Await confirmation** — affirmative reply → `confirmed`; correction → re-parse and re-summarize; negative or timeout → expire

Message copy requirements: identify Leopard Mark by name in the first message of a conversation, include opt-out language on the opt-in message, and keep the confirmation summary unambiguous — product name, format, quantity, unit price, line total, order total, delivery window, and the account it's being placed against. Never abbreviate quantities in a way that could be misread.

### 5.3 The AI ordering agent

**Parsing.** Given the message, the account's product catalog, and the account's recent order history, return structured JSON. Handle the real messages people send: `"same as last time"`, `"2 halves of cantinesca and a case of sunlight"`, `"send 4 more sixtels"`, `"double my usual"`. Resolve fuzzy product references against the SKU catalog — `"cantinesca"`, `"CNT"`, `"the lager"`, `"half barrel"`, `"1/2 bbl"`, `"sixtel"`, `"1/6"` all need to map correctly.

**Confidence and escalation.** The agent must be able to say it isn't sure. Low confidence, ambiguous product match, a quantity far outside the account's normal pattern, or any unrecognized product → do not guess. Either ask a clarifying question or escalate to Slack for a human. Set `needs_human_review` and make it visible.

**What the agent may and may not do autonomously:**

| Action | Autonomous? |
|---|---|
| Parse a message and reply with a confirmation summary | Yes |
| Create an order once the customer confirms | Yes |
| Schedule a confirmed order into the next available delivery window | Yes |
| Write a confirmed order to the Sheet and notify Slack | Yes |
| Answer an order-status question from synced data | Yes |
| Confirm an order on the customer's behalf | **Never** |
| Apply a discount or change pricing | **Never** — escalate |
| Override a credit hold or failed license check | **Never** — escalate |
| Create an order for an unrecognized number | **Never** — escalate |
| Cancel or modify a confirmed order | **Never** — escalate to the rep |

Version the agent's prompt and store the version on every interpretation, so a parsing regression is diagnosable after the fact.

### 5.5 WhatsApp — cut from scope, and why

Do not build a WhatsApp channel. This was verified against Meta's published WhatsApp Business Messaging Policy, not assumed:

- Alcohol is a **"Regulated Vertical."** Messaging about Regulated Verticals is **prohibited outright on the WhatsApp Business App**, and permitted on the **WhatsApp Business Platform only in an enumerated list of allowed countries**.
- **The United States is not on that list.** The policy enumerates 54 jurisdictions. Several US territories appear (American Samoa, Guam, Northern Mariana Islands, Puerto Rico, US Virgin Islands) — the US mainland does not.
- Even in permitted countries, Meta prohibits "providing any commerce experiences to buy or sell goods or services that are Regulated Verticals" — so catalog/cart ordering for alcohol is barred regardless.

Building it anyway risks suspension of the business account. If the user asks for WhatsApp, point them here and ask them to get written confirmation from a WhatsApp Business Solution Provider first. Keep the channel abstraction in the message pipeline so it can be added later if the policy changes, but ship nothing against the WhatsApp API.

### 5.4 Slack integration

A `#orders` channel (or per-region channels — ask the user) receiving:
- New confirmed orders — account, line items, total, rep, channel, with a link into the admin view
- Escalations needing a human — unknown sender, low-confidence parse, failed license/credit check, unusual quantity — as actionable messages with Approve / Reject / Assign-to-rep buttons that write back into the system
- Daily summary of orders placed and anything still awaiting confirmation

Slack is the **oversight** surface, not a second source of truth — every Slack action must be recorded as an `order_event` in Postgres.

---

## 6. Build phases

Do not attempt this in one pass. Propose a plan with roughly these phases and get sign-off on each:

1. **Foundation** — Next.js scaffold, Postgres schema, migrations, import the 107 accounts + products from the Sheet, admin auth
2. **Sheet sync** — bidirectional sync with the `Order ID` column, conflict rules, `sync_log`, idempotency, backfill existing orders. *Prove this works before building anything on top of it.*
3. **Customer portal** — auth, ordering, reorder-last, order history, T&C acceptance
4. **Rep app cutover** — point the existing PWA at the new API without changing its UX
5. **SMS channel** — Twilio integration, consent flow, keyword handling, confirmation loop. **Ship after 10DLC registration is approved, not before.**
6. **AI agent** — parsing, confidence scoring, escalation, order execution
7. **Slack** — notifications, then interactive escalation handling
8. ~~**WhatsApp**~~ — **CUT. Do not build.** Meta's WhatsApp Business Messaging Policy classifies alcohol as a Regulated Vertical and does not list the United States among the countries where alcohol messaging is permitted; commerce experiences for buying/selling alcohol are separately prohibited even in permitted countries. See Section 5.5.

---

## 7. Testing requirements

Explicit test coverage for:

- **The confirmation gate** — assert that no code path creates a `confirmed` order without a recorded customer confirmation. This is the single most important test in the codebase.
- **Authorized-sender rejection** — unknown numbers never produce orders
- **License and credit gates** — independently, and in combination; a paid account with a lapsed license must be blocked
- **STOP handling** — from any conversation state, including mid-order
- **Sheet sync idempotency** — replaying the same sync never duplicates rows
- **Sync conflict resolution** — both directions, per the Section 3.4 rule
- **AI parsing** — a fixture set of real-world message phrasings, including deliberately ambiguous ones that *should* escalate rather than parse
- **Quantity edge cases** — the `"6"` vs `"60"` class of misread must be caught by confirmation, and tested as such

---

## 8. Things to ask the user before building

Do not guess on these:

1. Which states have active accounts, and are the per-state distribution rules known yet?
2. Should the portal show pricing to customers, or stay quote-on-invoice like the rep app currently does?
3. One Slack channel or per-region channels? Which workspace/channel IDs?
4. Which SMS provider account, and has A2P 10DLC registration been started?
5. ~~WhatsApp setup~~ — resolved, out of scope (Section 5.5). Only revisit if the user produces written confirmation from a Solution Provider.
6. Should reps be able to place orders *as* an account in the new portal, or does the rep app stay separate?
7. Should `Price (ea)` / `Line Total` now be written to the Sheet at order time (they're currently left blank by design)?
8. Delivery scheduling: fixed weekly routes per region, or ad-hoc?

---

## 9. Ground rules

- **Plan before building.** Start in plan mode; present the plan; wait for approval.
- **Never break the rep app.** Reps use it daily throughout this build.
- **Never break the Sheet.** Ops uses it daily. Test sync against a *copy* of the spreadsheet before pointing at the real one.
- **Compliance constraints in Section 1 are not negotiable** — if a requirement seems to conflict with one, raise it, don't work around it.
- Secrets in environment variables only; `.env.local` already exists and is gitignored — never commit credentials.
- Every AI-driven decision must be traceable: what was received, what was understood, what was sent back, what the customer said.
