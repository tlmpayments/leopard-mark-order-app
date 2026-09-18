/**
 * The mirror's Notion schema.
 *
 * Design rules, all of which exist to keep this safe to rebuild from scratch:
 *
 *  - Every database carries an `External ID` text property holding the Postgres
 *    primary key. That is the join key for upserts, which is why the mirror
 *    needs no columns added to the app's schema — nothing about this feature
 *    touches prisma/schema.prisma.
 *  - Relations are declared with `SYNTHETIC` targets and resolved to real
 *    database ids at provision time (see provision.ts), because Notion needs
 *    the target database to exist before a relation property can point at it.
 *  - Enum-backed fields become `select` with the options pre-declared, so views
 *    can group and filter on them the moment the database is created rather
 *    than after the first row of each value arrives.
 *  - `Open in Ops` is a url on every actionable database. Notion is the read
 *    layer; the button that *does* the thing lives in the app, and this is the
 *    door back to it.
 *
 * SENSITIVITY: databases marked `internalOnly` carry pricing, margin-adjacent
 * or billing data. Notion permissions are per-database, not per-property, so an
 * external guest shared into a database sees every column in it. Keep these out
 * of any page shared outside the company.
 */

export type PropDef = Record<string, unknown>;

export type DbDef = {
  key: string;
  title: string;
  /** Contains pricing/billing data — never share with external guests. */
  internalOnly: boolean;
  icon: string;
  properties: Record<string, PropDef>;
};

const title = () => ({ title: {} });
const text = () => ({ rich_text: {} });
const num = (format = "number") => ({ number: { format } });
const money = () => num("dollar");
const date = () => ({ date: {} });
const check = () => ({ checkbox: {} });
const url = () => ({ url: {} });
const email = () => ({ email: {} });
const phone = () => ({ phone_number: {} });
const select = (...options: string[]) => ({
  select: { options: options.map((name) => ({ name })) },
});
/** Resolved to a real database id in provision.ts. */
export const relation = (targetKey: string) => ({ __relation: targetKey });

export const DATABASES: DbDef[] = [
  {
    key: "accounts",
    title: "Accounts",
    internalOnly: false,
    icon: "🏢",
    properties: {
      "Business name": title(),
      "External ID": text(),
      "Legal entity": text(),
      "License #": text(),
      "License state": text(),
      "License status": select("active", "expired", "suspended", "unknown"),
      "License expiry": date(),
      Approval: select("pending", "approved", "rejected"),
      Region: select("BA", "LA"),
      Rep: select(),
      Address: text(),
      "Delivery address": text(),
      "Delivery window": text(),
      "Delivery instructions": text(),
      Terms: text(),
      "Payment method": text(),
      "Credit hold": check(),
      Priority: select("high", "medium", "low"),
      "Tax exempt": check(),
      "Billing email": email(),
      "First order": date(),
      Created: date(),
      "Open in Ops": url(),
    },
  },
  {
    key: "contacts",
    title: "Contacts",
    internalOnly: false,
    icon: "👤",
    properties: {
      Name: title(),
      "External ID": text(),
      Account: relation("accounts"),
      Email: email(),
      Phone: phone(),
      Role: text(),
      "Authorized sender": check(),
    },
  },
  {
    key: "products",
    title: "Products",
    internalOnly: true, // list price
    icon: "🍺",
    properties: {
      Name: title(),
      "External ID": text(),
      SKU: text(),
      Format: text(),
      "Format detail": text(),
      Unit: text(),
      "List price": money(),
      Brand: text(),
      "Package type": text(),
      Keg: check(),
      Deposit: money(),
      "Reorder threshold": num(),
      UPC: text(),
      Active: check(),
    },
  },
  {
    key: "orders",
    title: "Orders",
    internalOnly: true, // order value
    icon: "📦",
    properties: {
      "Order #": title(),
      "External ID": text(),
      Account: relation("accounts"),
      Status: select(
        "draft", "pending_confirmation", "confirmed", "scheduled",
        "fulfilled", "cancelled", "rejected", "expired",
      ),
      Channel: select("portal", "sms", "rep_app"),
      Rep: select(),
      Total: money(),
      Submitted: date(),
      Confirmed: date(),
      Scheduled: date(),
      "Delivery date": date(),
      Delivered: date(),
      "Invoice #": text(),
      "Invoice status": select("draft", "open", "paid", "uncollectible", "void"),
      "BOL #": text(),
      "Payment method": text(),
      "Empty kegs expected": num(),
      "Tap handle requested": check(),
      "Blocked reason": text(),
      Notes: text(),
      "Open in Ops": url(),
    },
  },
  {
    key: "orderLines",
    title: "Order Lines",
    internalOnly: true, // unit pricing
    icon: "🧾",
    properties: {
      Line: title(),
      "External ID": text(),
      Order: relation("orders"),
      Product: relation("products"),
      Qty: num(),
      "Unit price": money(),
      "Line total": money(),
      "Lot #": text(),
    },
  },
  {
    key: "invoices",
    title: "Invoices",
    internalOnly: true, // billing
    icon: "💳",
    properties: {
      "Invoice #": title(),
      "External ID": text(),
      Account: relation("accounts"),
      Order: relation("orders"),
      Status: select("draft", "open", "paid", "uncollectible", "void"),
      "Collection method": select("charge_automatically", "send_invoice"),
      "Amount due": money(),
      "Amount paid": money(),
      "Due date": date(),
      Sent: date(),
      Paid: date(),
      "Stripe invoice": url(),
      PDF: url(),
    },
  },
  {
    key: "prospects",
    title: "Prospects",
    internalOnly: false,
    icon: "🎯",
    properties: {
      Name: title(),
      "External ID": text(),
      Owner: text(),
      Address: text(),
      City: text(),
      ZIP: text(),
      "License type": text(),
      "ABC status": text(),
      Segment: select("Independent", "Chain", "Producer (brewery/distillery)", "Hotel", "Other"),
      Tier: select("A", "B", "C"),
      Wave: text(),
      Route: select(),
      Stop: num(),
      Region: select("LA", "BA"),
      Status: select("new", "visited", "interested", "comeback", "signed", "nofit"),
      "Last visit": date(),
      Rep: select(),
      Note: text(),
      Map: url(),
    },
  },
  {
    key: "routes",
    title: "Delivery Routes",
    internalOnly: false,
    icon: "🚚",
    properties: {
      Route: title(),
      "External ID": text(),
      Date: date(),
      Region: select("BA", "LA"),
      Status: select("draft", "dispatched", "in_progress", "completed", "cancelled"),
      Driver: select(),
      Warehouse: text(),
      Dispatched: date(),
      Started: date(),
      Completed: date(),
      Notes: text(),
      "Open in Ops": url(),
    },
  },
  {
    key: "stops",
    title: "Route Stops",
    internalOnly: false,
    icon: "📍",
    properties: {
      Stop: title(),
      "External ID": text(),
      Route: relation("routes"),
      Order: relation("orders"),
      Sequence: num(),
      Status: select("pending", "delivered", "failed", "skipped"),
      Address: text(),
      Arrived: date(),
      Completed: date(),
      Photos: num(),
      "Failure reason": text(),
      Notes: text(),
    },
  },
  {
    key: "documents",
    title: "Documents",
    internalOnly: false,
    icon: "📄",
    properties: {
      "Doc #": title(),
      "External ID": text(),
      Type: select("delivery_receipt", "straight_bol", "invoice"),
      Account: relation("accounts"),
      Order: relation("orders"),
      Summary: text(),
      Created: date(),
      "Open in Ops": url(),
    },
  },
  {
    key: "inventory",
    title: "Inventory",
    internalOnly: false,
    icon: "📊",
    properties: {
      Item: title(),
      "External ID": text(),
      Product: relation("products"),
      Location: text(),
      "On hand": num(),
      Reserved: num(),
      Available: num(),
      "As of": date(),
    },
  },
  {
    key: "jobs",
    title: "Automations",
    internalOnly: false,
    icon: "⚙️",
    properties: {
      Job: title(),
      "External ID": text(),
      Kind: select(),
      Status: select("queued", "running", "succeeded", "failed", "dead"),
      Attempts: num(),
      "Max attempts": num(),
      "Run after": date(),
      Started: date(),
      Finished: date(),
      "Duration ms": num(),
      "Last error": text(),
      "Open in Ops": url(),
    },
  },
];

export const byKey = (key: string): DbDef => {
  const db = DATABASES.find((d) => d.key === key);
  if (!db) throw new Error(`Unknown database key: ${key}`);
  return db;
};
