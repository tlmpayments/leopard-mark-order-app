import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DATABASES, byKey } from '@/lib/notion/schema';
import { upsert, mappers, loadIdMap, type IdMap } from '@/lib/notion/sync';

/**
 * The mirror's job is to be safe and rebuildable, so these tests concentrate on
 * the two ways it could stop being either: writing to Postgres, and silently
 * corrupting or duplicating rows on the Notion side.
 */

/** Stand-in for NotionClient that records calls instead of making them. */
function fakeNotion(pages: Array<{ id: string; properties: Record<string, any> }> = []) {
  const created: any[] = [];
  const updated: any[] = [];
  let seq = 0;
  return {
    created,
    updated,
    queryAll: vi.fn(async () => pages),
    createPage: vi.fn(async (body: any) => { created.push(body); return { id: `new_${++seq}` }; }),
    updatePage: vi.fn(async (id: string, body: any) => { updated.push({ id, body }); return { id }; }),
  } as any;
}

const externalPage = (id: string, external: string) => ({
  id,
  properties: { 'External ID': { rich_text: [{ plain_text: external }] } },
});

describe('read-only guarantee', () => {
  const original = { ...process.env };
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { process.env = { ...original }; });

  it('refuses to run when the mirror is pointed at the app read-write role', async () => {
    process.env.DATABASE_URL = 'postgres://rw@host/db';
    process.env.NOTION_SYNC_DATABASE_URL = 'postgres://rw@host/db';
    const extract = await import('@/lib/notion/extract');
    await expect(extract.products()).rejects.toThrow(/read-only Postgres role/);
  });

  it('refuses to run with no mirror connection string at all', async () => {
    process.env.DATABASE_URL = 'postgres://rw@host/db';
    delete process.env.NOTION_SYNC_DATABASE_URL;
    const extract = await import('@/lib/notion/extract');
    await expect(extract.products()).rejects.toThrow(/NOTION_SYNC_DATABASE_URL is not set/);
  });

  it('never imports the app database client, which carries write credentials', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../lib/notion/extract.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(src).toMatch(/START TRANSACTION READ ONLY/);
  });
});

describe('upsert identity', () => {
  it('creates a page when the External ID is new and updates when it is known', async () => {
    const notion = fakeNotion();
    const existing: IdMap = new Map([['acc_1', 'page_1']]);
    const rows = [{ id: 'acc_1', name: 'Known' }, { id: 'acc_2', name: 'New' }];

    const { report, pages } = await upsert(
      notion, { key: 'accounts', databaseId: 'db_1' }, rows,
      r => r.id, r => ({ Name: { title: [{ text: { content: r.name } }] } }), existing,
    );

    expect(report).toMatchObject({ created: 1, updated: 1, skipped: 0 });
    expect(report.errors).toEqual([]);
    expect(pages.get('acc_2')).toBe('new_1');
    // The known row was patched in place, not duplicated.
    expect(notion.updated[0].id).toBe('page_1');
  });

  it('stamps External ID on every page so the next run can find it again', async () => {
    const notion = fakeNotion();
    await upsert(notion, { key: 'accounts', databaseId: 'db_1' }, [{ id: 'acc_9' }],
      r => r.id, () => ({}), new Map());
    expect(notion.created[0].properties['External ID'].rich_text[0].text.content).toBe('acc_9');
  });

  it('keeps going when one row fails, and reports which one', async () => {
    const notion = fakeNotion();
    notion.createPage = vi.fn(async (body: any) => {
      if (body.properties['External ID'].rich_text[0].text.content === 'bad') throw new Error('validation_error');
      return { id: 'ok' };
    });
    const { report } = await upsert(notion, { key: 'x', databaseId: 'db' },
      [{ id: 'good1' }, { id: 'bad' }, { id: 'good2' }], r => r.id, () => ({}), new Map());
    expect(report.created).toBe(2);
    expect(report.errors).toEqual([{ externalId: 'bad', message: 'validation_error' }]);
  });

  it('reads back the External ID map that a previous run wrote', async () => {
    const notion = fakeNotion([externalPage('p1', 'acc_1'), externalPage('p2', 'acc_2'), { id: 'p3', properties: {} }]);
    const map = await loadIdMap(notion, 'db_1');
    expect(map.get('acc_1')).toBe('p1');
    expect(map.size).toBe(2); // the page with no External ID is ignored, not guessed at
  });
});

describe('property encoding', () => {
  const account = (over: Record<string, unknown> = {}) => mappers.accounts({
    id: 'a1', business_name: 'Test Bar', legal_entity: null, license_number: null,
    license_state: null, license_status: 'active', license_expiry: null,
    approval_status: 'approved', region: 'LA', address: null, delivery_address: null,
    delivery_window: null, delivery_instructions: null, payment_method: null, terms: null,
    credit_hold: false, priority: null, tax_exempt: true, stripe_customer_id: null,
    billing_contact_email: null, first_order_at: null, created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'), rep_name: null, ...over,
  } as any);

  it('never emits an empty title, which would make an unfindable row', () => {
    for (const blank of ['', '   ']) {
      const props = account({ business_name: blank }) as any;
      expect(props['Business name'].title[0].text.content).toBe('(untitled)');
    }
  });

  it('truncates long text instead of failing the row on Notion 2000-char limit', () => {
    const props = account({ delivery_instructions: 'x'.repeat(5000) }) as any;
    expect(props['Delivery instructions'].rich_text[0].text.content).toHaveLength(2000);
  });

  it('strips commas from select values, which Notion rejects', () => {
    const props = account({ region: 'LA, West' }) as any;
    expect(props.Region.select.name).toBe('LA  West');
  });

  it('sends null rather than a bad date for missing timestamps', () => {
    const props = account({ first_order_at: null, license_expiry: 'not-a-date' }) as any;
    expect(props['First order'].date).toBeNull();
    expect(props['License expiry'].date).toBeNull();
  });

  it('links every account back to the ops app, which is where actions live', () => {
    expect((account() as any)['Open in Ops'].url).toMatch(/\/ops\/accounts\/a1$/);
  });

  it('leaves a relation empty rather than inventing a page id', () => {
    const line = mappers.orderLines(
      { id: 'l1', order_id: 'missing', product_id: 'p1', qty: 2, unit_price: '10.00',
        line_total: '20.00', lot_number: null, line_index: 1 } as any,
      new Map(), new Map([['p1', 'page_p1']]),
    ) as any;
    expect(line.Order.relation).toEqual([]);
    expect(line.Product.relation).toEqual([{ id: 'page_p1' }]);
  });
});

describe('schema contract', () => {
  it('gives every database an External ID, or upserts would duplicate on each run', () => {
    for (const db of DATABASES) expect(Object.keys(db.properties)).toContain('External ID');
  });

  it('gives every database exactly one title property', () => {
    for (const db of DATABASES) {
      const titles = Object.values(db.properties).filter(p => 'title' in p);
      expect(titles, `${db.key} title count`).toHaveLength(1);
    }
  });

  it('points every relation at a database that exists', () => {
    const keys = new Set(DATABASES.map(d => d.key));
    for (const db of DATABASES) {
      for (const [name, def] of Object.entries(db.properties)) {
        if (!('__relation' in def)) continue;
        expect(keys, `${db.key}.${name}`).toContain((def as any).__relation);
      }
    }
  });

  it('marks the pricing and billing databases as internal-only for guest sharing', () => {
    // Notion permissions are per-database, so these must never be shared out.
    for (const key of ['products', 'orders', 'orderLines', 'invoices']) {
      expect(byKey(key).internalOnly, key).toBe(true);
    }
  });
});
