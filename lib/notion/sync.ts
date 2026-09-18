/**
 * Postgres → Notion mirror.
 *
 * One direction only. Nothing in this file writes to Postgres (see extract.ts
 * for how that is enforced), and nothing reads user edits back out of Notion.
 * If someone edits a mirrored row in Notion, the next sync overwrites it —
 * that is the intended behaviour, not a bug to fix later. Notion is a window.
 *
 * Upsert key is the `External ID` property, holding the Postgres primary key.
 * Each run pulls the full page list per database once (hundreds of rows, three
 * requests) and builds an External ID → page id map, rather than issuing a
 * filtered query per row. That turns a 1,600-request sync into ~1,600 writes
 * plus ~30 reads.
 *
 * Deletes are never propagated. A row vanishing from Postgres leaves its Notion
 * page in place, because an accidental mirror bug must not be able to erase
 * something a human might be reading. Stale pages are pruned by hand.
 */
import { NotionClient } from "./client";
import { DATABASES, type DbDef } from "./schema";
import * as extract from "./extract";

const OPS = process.env.NOTION_OPS_BASE_URL ?? "https://ops.tlmbg.co";

/* ── Notion property value builders ───────────────────────────────────── */

/** Notion rejects rich_text items over 2000 chars. Truncate, don't fail a sync. */
const TEXT_LIMIT = 2000;

const pText = (v: unknown) => {
  const s = v == null ? "" : String(v);
  if (!s) return { rich_text: [] };
  const clipped = s.length > TEXT_LIMIT ? `${s.slice(0, TEXT_LIMIT - 1)}…` : s;
  return { rich_text: [{ text: { content: clipped } }] };
};

const pTitle = (v: unknown) => {
  // A blank title makes an unclickable, unsearchable row in Notion; give it
  // something rather than an empty page in the middle of a list.
  const s = (v == null ? "" : String(v)).trim() || "(untitled)";
  return { title: [{ text: { content: s.slice(0, TEXT_LIMIT) } }] };
};

const pNum = (v: unknown) => {
  if (v == null || v === "") return { number: null };
  const n = typeof v === "number" ? v : Number(v);
  return { number: Number.isFinite(n) ? n : null };
};

const pCheck = (v: unknown) => ({ checkbox: Boolean(v) });

const pDate = (v: unknown) => {
  if (!v) return { date: null };
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? { date: null } : { date: { start: d.toISOString() } };
};

/** Notion select option names cannot contain a comma. */
const pSelect = (v: unknown) => {
  const s = (v == null ? "" : String(v)).trim();
  return s ? { select: { name: s.replace(/,/g, " ").slice(0, 100) } } : { select: null };
};

const pUrl = (v: unknown) => {
  const s = (v == null ? "" : String(v)).trim();
  return { url: s || null };
};

const pEmail = (v: unknown) => {
  const s = (v == null ? "" : String(v)).trim();
  return { email: s || null };
};

const pPhone = (v: unknown) => {
  const s = (v == null ? "" : String(v)).trim();
  return { phone_number: s || null };
};

/** Relation to a page we created earlier this run; silently empty if unresolved. */
const pRel = (pageId: string | undefined) => ({ relation: pageId ? [{ id: pageId }] : [] });

/* ── Upsert engine ────────────────────────────────────────────────────── */

export type IdMap = Map<string, string>; // External ID → Notion page id

export type SyncReport = {
  database: string;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ externalId: string; message: string }>;
};

/** Reads the `External ID` plain text off a Notion page. */
function externalIdOf(page: { properties: Record<string, any> }): string | null {
  const prop = page.properties?.["External ID"];
  const first = prop?.rich_text?.[0];
  return first?.plain_text ?? first?.text?.content ?? null;
}

export async function loadIdMap(notion: NotionClient, databaseId: string): Promise<IdMap> {
  const map: IdMap = new Map();
  for (const page of await notion.queryAll(databaseId)) {
    const external = externalIdOf(page);
    if (external) map.set(external, page.id);
  }
  return map;
}

/**
 * Upserts `rows` into one Notion database.
 *
 * A failure on one row is recorded and the run continues: a single malformed
 * note should not stop the other 1,599 rows from mirroring.
 */
export async function upsert<T>(
  notion: NotionClient,
  db: { key: string; databaseId: string },
  rows: T[],
  externalId: (row: T) => string,
  properties: (row: T) => Record<string, unknown>,
  existing: IdMap,
): Promise<{ report: SyncReport; pages: IdMap }> {
  const report: SyncReport = { database: db.key, created: 0, updated: 0, skipped: 0, errors: [] };
  const pages: IdMap = new Map(existing);

  for (const row of rows) {
    const key = externalId(row);
    if (!key) {
      report.skipped++;
      continue;
    }
    try {
      const props = { "External ID": pText(key), ...properties(row) };
      const pageId = existing.get(key);
      if (pageId) {
        await notion.updatePage(pageId, { properties: props });
        report.updated++;
      } else {
        const created = await notion.createPage({
          parent: { database_id: db.databaseId },
          properties: props,
        });
        pages.set(key, created.id);
        report.created++;
      }
    } catch (error) {
      report.errors.push({ externalId: key, message: (error as Error).message });
    }
  }
  return { report, pages };
}

/* ── Per-entity property mappers ──────────────────────────────────────── */

export const mappers = {
  accounts: (r: extract.AccountRow) => ({
    "Business name": pTitle(r.business_name),
    "Legal entity": pText(r.legal_entity),
    "License #": pText(r.license_number),
    "License state": pText(r.license_state),
    "License status": pSelect(r.license_status),
    "License expiry": pDate(r.license_expiry),
    Approval: pSelect(r.approval_status),
    Region: pSelect(r.region),
    Rep: pSelect(r.rep_name),
    Address: pText(r.address),
    "Delivery address": pText(r.delivery_address),
    "Delivery window": pText(r.delivery_window),
    "Delivery instructions": pText(r.delivery_instructions),
    Terms: pText(r.terms),
    "Payment method": pText(r.payment_method),
    "Credit hold": pCheck(r.credit_hold),
    Priority: pSelect(r.priority),
    "Tax exempt": pCheck(r.tax_exempt),
    "Billing email": pEmail(r.billing_contact_email),
    "First order": pDate(r.first_order_at),
    Created: pDate(r.created_at),
    "Open in Ops": pUrl(`${OPS}/ops/accounts/${r.id}`),
  }),

  contacts: (r: extract.ContactRow, accounts: IdMap) => ({
    Name: pTitle(r.name),
    Account: pRel(accounts.get(r.account_id)),
    Email: pEmail(r.email),
    Phone: pPhone(r.phone_e164),
    Role: pText(r.role),
    "Authorized sender": pCheck(r.is_authorized_sender),
  }),

  products: (r: extract.ProductRow) => ({
    Name: pTitle(r.product_name),
    SKU: pText(r.sku_code),
    Format: pText(r.format_label),
    "Format detail": pText(r.format_detail),
    Unit: pText(r.unit),
    "List price": pNum(r.list_price),
    Brand: pText(r.brand_code),
    "Package type": pText(r.package_type),
    Keg: pCheck(r.is_keg),
    Deposit: pNum(r.deposit_amount),
    "Reorder threshold": pNum(r.reorder_threshold),
    UPC: pText(r.upc),
    Active: pCheck(r.active),
  }),

  orders: (r: extract.OrderRow, accounts: IdMap) => ({
    "Order #": pTitle(r.invoice_number || r.id),
    Account: pRel(accounts.get(r.account_id)),
    Status: pSelect(r.status),
    Channel: pSelect(r.channel),
    Rep: pSelect(r.rep_name),
    Total: pNum(r.line_total),
    Submitted: pDate(r.submitted_at),
    Confirmed: pDate(r.confirmed_at),
    Scheduled: pDate(r.scheduled_for),
    "Delivery date": pDate(r.delivery_date),
    Delivered: pDate(r.delivered_at),
    "Invoice #": pText(r.invoice_number),
    "Invoice status": pSelect(r.invoice_status),
    "BOL #": pText(r.bol_number),
    "Payment method": pText(r.payment_method),
    "Empty kegs expected": pNum(r.expected_empty_kegs),
    "Tap handle requested": pCheck(r.tap_handle_requested),
    "Blocked reason": pText(r.blocked_reason),
    Notes: pText(r.notes),
    "Open in Ops": pUrl(`${OPS}/ops/orders/${r.id}`),
  }),

  orderLines: (r: extract.OrderLineRow, orders: IdMap, products: IdMap) => ({
    Line: pTitle(`${r.order_id} · line ${r.line_index}`),
    Order: pRel(orders.get(r.order_id)),
    Product: pRel(products.get(r.product_id)),
    Qty: pNum(r.qty),
    "Unit price": pNum(r.unit_price),
    "Line total": pNum(r.line_total),
    "Lot #": pText(r.lot_number),
  }),

  invoices: (r: extract.InvoiceRow, accounts: IdMap, orders: IdMap) => ({
    "Invoice #": pTitle(r.invoice_number || r.stripe_invoice_id),
    Account: pRel(accounts.get(r.account_id)),
    Order: pRel(orders.get(r.order_id)),
    Status: pSelect(r.status),
    "Collection method": pSelect(r.collection_method),
    "Amount due": pNum(r.amount_due),
    "Amount paid": pNum(r.amount_paid),
    "Due date": pDate(r.due_date),
    Sent: pDate(r.sent_at),
    Paid: pDate(r.paid_at),
    "Stripe invoice": pUrl(r.hosted_invoice_url),
    PDF: pUrl(r.pdf_url),
  }),

  routes: (r: extract.RouteRow) => ({
    Route: pTitle(r.name || `${r.region} · ${new Date(r.date).toISOString().slice(0, 10)}`),
    Date: pDate(r.date),
    Region: pSelect(r.region),
    Status: pSelect(r.status),
    Driver: pSelect(r.driver_name),
    Warehouse: pText(r.warehouse_name),
    Dispatched: pDate(r.dispatched_at),
    Started: pDate(r.started_at),
    Completed: pDate(r.completed_at),
    Notes: pText(r.notes),
    "Open in Ops": pUrl(`${OPS}/ops/deliveries/routes/${r.id}`),
  }),

  stops: (r: extract.StopRow, routes: IdMap, orders: IdMap) => ({
    Stop: pTitle(r.stop_name || `Stop ${r.sequence}`),
    Route: pRel(routes.get(r.route_id)),
    Order: pRel(r.order_id ? orders.get(r.order_id) : undefined),
    Sequence: pNum(r.sequence),
    Status: pSelect(r.status),
    Address: pText(r.stop_address),
    Arrived: pDate(r.arrived_at),
    Completed: pDate(r.completed_at),
    Photos: pNum(r.photo_count),
    "Failure reason": pText(r.failure_reason),
    Notes: pText(r.notes),
  }),

  documents: (r: extract.DocumentRow, accounts: IdMap, orders: IdMap) => ({
    "Doc #": pTitle(r.doc_number),
    Type: pSelect(r.doc_type),
    Account: pRel(r.account_id ? accounts.get(r.account_id) : undefined),
    Order: pRel(r.order_id ? orders.get(r.order_id) : undefined),
    Summary: pText(r.summary),
    Created: pDate(r.created_at),
    "Open in Ops": pUrl(`${OPS}/ops/documents`),
  }),

  inventory: (r: extract.InventoryRow, products: IdMap, asOf: Date) => ({
    Item: pTitle(`${r.sku_code} @ ${r.location_name}`),
    Product: pRel(products.get(r.product_id)),
    Location: pText(r.location_name),
    "On hand": pNum(r.on_hand),
    Reserved: pNum(r.reserved),
    Available: pNum(r.available),
    "As of": pDate(asOf),
  }),

  jobs: (r: extract.JobRow) => ({
    Job: pTitle(r.kind),
    Kind: pSelect(r.kind),
    Status: pSelect(r.status),
    Attempts: pNum(r.attempts),
    "Max attempts": pNum(r.max_attempts),
    "Run after": pDate(r.run_after),
    Started: pDate(r.started_at),
    Finished: pDate(r.finished_at),
    "Duration ms": pNum(r.duration_ms),
    "Last error": pText(r.last_error),
    "Open in Ops": pUrl(`${OPS}/ops/automations`),
  }),

  prospects: (r: ProspectRow, visit: extract.ProspectVisitRow | undefined) => ({
    Name: pTitle(r.name || r.owner || `Prospect ${r.id}`),
    Owner: pText(r.owner),
    Address: pText(r.address),
    City: pText(r.city),
    ZIP: pText(r.zip),
    "License type": pText(r.licType),
    "ABC status": pText(r.abcStatus),
    Segment: pSelect(r.segment),
    Tier: pSelect(r.tier),
    Wave: pText(r.wave),
    Route: pSelect(r.route),
    Stop: pNum(r.stop),
    Region: pSelect("LA"),
    Status: pSelect(visit?.status ?? "new"),
    "Last visit": pDate(visit?.marked_at),
    Rep: pSelect(visit?.rep_name),
    Note: pText(visit?.note),
    Map: pUrl(r.lat && r.lng ? `https://www.google.com/maps/search/?api=1&query=${r.lat},${r.lng}` : ""),
  }),
};

/* ── Prospects come from the rep app's static data file, not Postgres ──── */

export type ProspectRow = {
  id: number; name: string; owner: string; licType: string; abcStatus: string;
  zip: string; address: string; city: string; segment: string; tier: string;
  wave: string; route: string; stop: number | null; lat: number | null; lng: number | null;
};

/**
 * `public/rep-app/assets/js/prospects.js` assigns `window.LM_PROSPECTS`. It is
 * the permanent key space for prospect ids (the file says so, loudly), so the
 * mirror reads it rather than duplicating the list. Evaluated with a stub
 * `window` because the file is data, not a module.
 */
export async function loadProspects(): Promise<ProspectRow[]> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const src = await readFile(
    join(process.cwd(), "public/rep-app/assets/js/prospects.js"),
    "utf8",
  );
  const stub: { LM_PROSPECTS?: ProspectRow[] } = {};
  new Function("window", src)(stub);
  if (!stub.LM_PROSPECTS?.length) throw new Error("prospects.js did not define window.LM_PROSPECTS");
  return stub.LM_PROSPECTS;
}

export { DATABASES, type DbDef };
