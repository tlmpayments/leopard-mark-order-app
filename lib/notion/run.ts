/**
 * Full mirror run, in dependency order.
 *
 * Order is not cosmetic: a Notion relation can only be set to a page that
 * already exists, so accounts must land before contacts, orders before lines,
 * and routes before stops. Each stage hands its External ID → page id map
 * forward.
 *
 * `since` drives incremental runs for the tables that carry `updated_at`.
 * Everything else is small enough to resync whole, which avoids a class of bug
 * where a child row changes but its parent's timestamp doesn't move.
 */
import { NotionClient } from "./client";
import { readConfig, requireToken } from "./config";
import * as extract from "./extract";
import { loadIdMap, loadProspects, mappers, upsert, type IdMap, type SyncReport } from "./sync";

export type RunOptions = {
  /** Only resync rows changed after this instant. Omit for a full rebuild. */
  since?: Date | null;
  /** Restrict the run to these database keys. */
  only?: string[];
};

export async function runSync(options: RunOptions = {}): Promise<{
  reports: SyncReport[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}> {
  const started = Date.now();
  const since = options.since ?? null;
  const config = await readConfig();
  const notion = new NotionClient(requireToken());
  const reports: SyncReport[] = [];

  const wanted = (key: string) => !options.only || options.only.includes(key);
  const target = (key: string) => {
    const entry = config.databases[key];
    if (!entry) throw new Error(`No provisioned database for "${key}" — re-run notion:provision`);
    return { key, databaseId: entry.id };
  };

  // Maps are needed by later stages even when their own stage is skipped, so
  // load them whenever any dependent stage is in scope.
  const needAccounts = wanted("accounts") || wanted("contacts") || wanted("orders") || wanted("invoices") || wanted("documents");
  const needProducts = wanted("products") || wanted("orderLines") || wanted("inventory");
  const needOrders = wanted("orders") || wanted("orderLines") || wanted("invoices") || wanted("stops") || wanted("documents");
  const needRoutes = wanted("routes") || wanted("stops");

  let accounts: IdMap = new Map();
  let products: IdMap = new Map();
  let orders: IdMap = new Map();
  let routes: IdMap = new Map();

  if (needAccounts) {
    accounts = await loadIdMap(notion, target("accounts").databaseId);
    if (wanted("accounts")) {
      const rows = await extract.accounts({ since });
      const out = await upsert(notion, target("accounts"), rows, (r) => r.id, mappers.accounts, accounts);
      accounts = out.pages;
      reports.push(out.report);
    }
  }

  if (wanted("contacts")) {
    const existing = await loadIdMap(notion, target("contacts").databaseId);
    const rows = await extract.contacts();
    const out = await upsert(notion, target("contacts"), rows, (r) => r.id, (r) => mappers.contacts(r, accounts), existing);
    reports.push(out.report);
  }

  if (needProducts) {
    products = await loadIdMap(notion, target("products").databaseId);
    if (wanted("products")) {
      const rows = await extract.products();
      const out = await upsert(notion, target("products"), rows, (r) => r.id, mappers.products, products);
      products = out.pages;
      reports.push(out.report);
    }
  }

  if (needOrders) {
    orders = await loadIdMap(notion, target("orders").databaseId);
    if (wanted("orders")) {
      const rows = await extract.orders({ since });
      const out = await upsert(notion, target("orders"), rows, (r) => r.id, (r) => mappers.orders(r, accounts), orders);
      orders = out.pages;
      reports.push(out.report);
    }
  }

  if (wanted("orderLines")) {
    const existing = await loadIdMap(notion, target("orderLines").databaseId);
    const rows = await extract.orderLines();
    const out = await upsert(notion, target("orderLines"), rows, (r) => r.id, (r) => mappers.orderLines(r, orders, products), existing);
    reports.push(out.report);
  }

  if (wanted("invoices")) {
    const existing = await loadIdMap(notion, target("invoices").databaseId);
    const rows = await extract.invoices({ since });
    const out = await upsert(notion, target("invoices"), rows, (r) => r.id, (r) => mappers.invoices(r, accounts, orders), existing);
    reports.push(out.report);
  }

  if (needRoutes) {
    routes = await loadIdMap(notion, target("routes").databaseId);
    if (wanted("routes")) {
      const rows = await extract.routes({ since });
      const out = await upsert(notion, target("routes"), rows, (r) => r.id, mappers.routes, routes);
      routes = out.pages;
      reports.push(out.report);
    }
  }

  if (wanted("stops")) {
    const existing = await loadIdMap(notion, target("stops").databaseId);
    const rows = await extract.routeStops();
    const out = await upsert(notion, target("stops"), rows, (r) => r.id, (r) => mappers.stops(r, routes, orders), existing);
    reports.push(out.report);
  }

  if (wanted("documents")) {
    const existing = await loadIdMap(notion, target("documents").databaseId);
    const rows = await extract.documents();
    const out = await upsert(notion, target("documents"), rows, (r) => r.id, (r) => mappers.documents(r, accounts, orders), existing);
    reports.push(out.report);
  }

  if (wanted("inventory")) {
    const existing = await loadIdMap(notion, target("inventory").databaseId);
    const rows = await extract.inventory();
    const asOf = new Date();
    // The view has no natural key; product+location is the grain.
    const out = await upsert(notion, target("inventory"), rows, (r) => `${r.product_id}:${r.location_id}`, (r) => mappers.inventory(r, products, asOf), existing);
    reports.push(out.report);
  }

  if (wanted("jobs")) {
    const existing = await loadIdMap(notion, target("jobs").databaseId);
    const rows = await extract.jobRuns();
    const out = await upsert(notion, target("jobs"), rows, (r) => r.id, mappers.jobs, existing);
    reports.push(out.report);
  }

  if (wanted("prospects")) {
    const existing = await loadIdMap(notion, target("prospects").databaseId);
    const rows = await loadProspects();
    const visits = new Map((await extract.prospectVisits()).map((v) => [v.prospect_id, v]));
    const out = await upsert(notion, target("prospects"), rows, (r) => String(r.id), (r) => mappers.prospects(r, visits.get(r.id)), existing);
    reports.push(out.report);
  }

  const finished = Date.now();
  return {
    reports,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
  };
}
