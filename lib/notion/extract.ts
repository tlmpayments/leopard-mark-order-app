/**
 * Read side of the Notion mirror.
 *
 * Two independent guarantees that this process cannot modify Postgres:
 *
 *  1. It connects with NOTION_SYNC_DATABASE_URL, which should point at a Neon
 *     role granted only SELECT. `assertDistinctFromPrimary()` refuses to start
 *     if that URL is just DATABASE_URL copied over, because a read-only mirror
 *     silently running as the app's read-write role is exactly the failure this
 *     design exists to prevent.
 *  2. Every statement runs inside START TRANSACTION READ ONLY, so even a
 *     misconfigured role cannot write — Postgres rejects it at the server.
 *
 * Belt and braces is deliberate. (1) can be got wrong by a human editing env
 * vars; (2) cannot.
 *
 * It also deliberately does NOT use lib/db.ts / Prisma. Sharing the app's pool
 * would share the app's read-write credentials, and importing the app's client
 * here would make it possible for a future edit to reach a `.create()`.
 */
import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;

function assertDistinctFromPrimary(url: string): void {
  const primary = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (primary && url === primary) {
    throw new Error(
      "NOTION_SYNC_DATABASE_URL is identical to DATABASE_URL. Point it at a " +
        "read-only Postgres role — see docs/notion-mirror.md. Refusing to run " +
        "the mirror with read-write credentials.",
    );
  }
}

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.NOTION_SYNC_DATABASE_URL;
  if (!url) throw new Error("NOTION_SYNC_DATABASE_URL is not set");
  assertDistinctFromPrimary(url);
  pool = new Pool({ connectionString: url, max: 3 });
  return pool;
}

/** Runs `fn` inside a read-only transaction. Postgres enforces it server-side. */
async function readOnly<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("START TRANSACTION READ ONLY");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return readOnly(async (c) => (await c.query(sql, params)).rows as T[]);
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

/**
 * Incremental watermark. Tables without an `updated_at` (order_lines,
 * archived_documents, prospect_visits keyed by their parents) are pulled whole
 * — at these row counts that costs less than tracking per-table high-water
 * marks and getting the edge cases wrong.
 */
type Since = { since: Date | null };

const sinceClause = (col: string, since: Date | null) =>
  since ? `where ${col} > $1` : "";
const sinceParams = (since: Date | null) => (since ? [since] : []);

export type AccountRow = {
  id: string; business_name: string; legal_entity: string | null;
  license_number: string | null; license_state: string | null; license_status: string;
  license_expiry: Date | null; approval_status: string; region: string | null;
  address: string | null; delivery_address: string | null; delivery_window: string | null;
  delivery_instructions: string | null; payment_method: string | null; terms: string | null;
  credit_hold: boolean; priority: string | null; tax_exempt: boolean;
  stripe_customer_id: string | null; billing_contact_email: string | null;
  first_order_at: Date | null; created_at: Date; updated_at: Date; rep_name: string | null;
};

export const accounts = ({ since }: Since) =>
  rows<AccountRow>(
    `select a.*, r.name as rep_name
       from accounts a left join reps r on r.id = a.sales_rep_id
       ${sinceClause("a.updated_at", since)}
      order by a.business_name`,
    sinceParams(since),
  );

export type ContactRow = {
  id: string; account_id: string; name: string | null; email: string | null;
  phone_e164: string | null; role: string | null; is_authorized_sender: boolean; created_at: Date;
};

export const contacts = () =>
  rows<ContactRow>(`select * from contacts order by created_at`);

export type ProductRow = {
  id: string; sku_code: string; product_name: string; format_label: string;
  format_detail: string; unit: string; list_price: string; active: boolean;
  brand_code: string | null; package_type: string | null; is_keg: boolean;
  deposit_amount: string | null; reorder_threshold: number | null; upc: string | null;
};

export const products = () =>
  rows<ProductRow>(`select * from products order by sku_code`);

export type OrderRow = {
  id: string; account_id: string; contact_id: string | null; channel: string; status: string;
  submitted_at: Date | null; confirmed_at: Date | null; scheduled_for: Date | null;
  delivery_date: Date | null; delivered_at: Date | null; invoice_number: string | null;
  invoice_status: string | null; bol_number: string | null; payment_method: string | null;
  notes: string | null; blocked_reason: string | null; blocked_at: Date | null;
  expected_empty_kegs: number | null; tap_handle_requested: boolean | null;
  created_at: Date; updated_at: Date; rep_name: string | null; line_total: string | null;
};

export const orders = ({ since }: Since) =>
  rows<OrderRow>(
    `select o.*, r.name as rep_name,
            (select sum(l.line_total) from order_lines l where l.order_id = o.id) as line_total
       from orders o left join reps r on r.id = o.sales_rep_id
       ${sinceClause("o.updated_at", since)}
      order by o.created_at`,
    sinceParams(since),
  );

export type OrderLineRow = {
  id: string; order_id: string; product_id: string; qty: number; unit_price: string;
  line_total: string; lot_number: string | null; line_index: number;
};

export const orderLines = () =>
  rows<OrderLineRow>(`select * from order_lines order by order_id, line_index`);

export type InvoiceRow = {
  id: string; order_id: string; account_id: string; stripe_invoice_id: string; status: string;
  collection_method: string; amount_due: string; amount_paid: string; due_date: Date | null;
  hosted_invoice_url: string | null; sent_at: Date | null; paid_at: Date | null;
  invoice_number: string | null; pdf_url: string | null; updated_at: Date;
};

export const invoices = ({ since }: Since) =>
  rows<InvoiceRow>(
    `select * from invoices ${sinceClause("updated_at", since)} order by created_at`,
    sinceParams(since),
  );

export type RouteRow = {
  id: string; date: Date; region: string; status: string; name: string | null;
  dispatched_at: Date | null; started_at: Date | null; completed_at: Date | null;
  notes: string | null; updated_at: Date; driver_name: string | null; warehouse_name: string | null;
};

export const routes = ({ since }: Since) =>
  rows<RouteRow>(
    `select d.*, r.name as driver_name, l.name as warehouse_name
       from delivery_routes d
       left join reps r on r.id = d.driver_id
       left join locations l on l.id = d.warehouse_id
       ${sinceClause("d.updated_at", since)}
      order by d.date desc`,
    sinceParams(since),
  );

export type StopRow = {
  id: string; route_id: string; order_id: string | null; stop_name: string | null;
  stop_address: string | null; sequence: number; status: string; arrived_at: Date | null;
  completed_at: Date | null; failure_reason: string | null; notes: string | null;
  photo_count: number;
};

export const routeStops = () =>
  rows<StopRow>(
    `select s.*, (select count(*)::int from delivery_photos p where p.route_stop_id = s.id) as photo_count
       from route_stops s order by s.route_id, s.sequence`,
  );

export type DocumentRow = {
  id: string; doc_number: string; doc_type: string; summary: string;
  account_id: string | null; order_id: string | null; created_at: Date;
};

export const documents = () =>
  rows<DocumentRow>(
    `select id, doc_number, doc_type, summary, account_id, order_id, created_at
       from archived_documents order by created_at desc`,
  );

export type JobRow = {
  id: string; kind: string; status: string; attempts: number; max_attempts: number;
  run_after: Date; last_error: string | null; started_at: Date | null;
  finished_at: Date | null; duration_ms: number | null; order_id: string | null; created_at: Date;
};

/** Only the last 30 days: the mirror is a dashboard, not the job archive. */
export const jobRuns = () =>
  rows<JobRow>(
    `select * from job_runs where created_at > now() - interval '30 days' order by created_at desc`,
  );

export type InventoryRow = {
  product_id: string; location_id: string; on_hand: string; reserved: string;
  available: string; sku_code: string; product_name: string; location_name: string;
};

export const inventory = () =>
  rows<InventoryRow>(
    `select v.*, p.sku_code, p.product_name, l.name as location_name
       from available_for_delivery v
       join products p on p.id = v.product_id
       join locations l on l.id = v.location_id
      order by l.name, p.sku_code`,
  );

export type ProspectVisitRow = {
  prospect_id: number; status: string; note: string | null; rep_name: string; marked_at: Date;
};

export const prospectVisits = () =>
  rows<ProspectVisitRow>(`select * from prospect_visits`);
