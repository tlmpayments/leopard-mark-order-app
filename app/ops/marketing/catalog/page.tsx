import Link from "next/link";
import { db } from "@/lib/db";
import { requireOpsUser } from "@/lib/ops/session";
import {
  MARKETING_BRANDS,
  MARKETING_CATEGORIES,
  MARKETING_UNITS,
  categoryRank,
} from "@/lib/marketing/catalog";
import { createItemAction, setItemActiveAction, updateItemAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * The catalogue editor.
 *
 * This is the whole reason the catalogue moved out of the rep app's bundle:
 * every correction here — a changed supplier, a new sell sheet, a retired
 * sticker — reaches the field on the reps' next catalogue fetch instead of
 * waiting for someone to ship a PWA.
 *
 * Every row is its own form posting to a server action, rather than a client
 * component holding a draft. Twenty-odd items edited a few times a month does
 * not justify the state management, and a plain form cannot lose someone's
 * typing to a re-render.
 */

const EMPTY = {
  sku: "",
  name: "",
  brand: MARKETING_BRANDS[0] as string,
  category: MARKETING_CATEGORIES[0] as string,
  type: "physical",
  description: "",
  specs: "",
  unit: "each",
  supplier: "",
  leadTime: "",
  sortOrder: 0,
};

function ItemFields({
  item,
  idPrefix,
}: {
  item: typeof EMPTY & { brand: string; category: string; type: string };
  idPrefix: string;
}) {
  return (
    <>
      <div className="grid g3" style={{ gap: 10 }}>
        <label className="fldwrap">
          <span className="dim small">SKU</span>
          <input className="fld" name="sku" defaultValue={item.sku} required placeholder="CNT-POS-COAST4" />
        </label>
        <label className="fldwrap" style={{ gridColumn: "span 2" }}>
          <span className="dim small">Name</span>
          <input className="fld" name="name" defaultValue={item.name} required placeholder="Cantinesca Coaster" />
        </label>
      </div>

      <div className="grid g3" style={{ gap: 10, marginTop: 10 }}>
        <label className="fldwrap">
          <span className="dim small">Brand</span>
          {/* A list, not an enum — a brand signed this month must be orderable
              this month. See lib/marketing/catalog.ts. */}
          <input className="fld" name="brand" defaultValue={item.brand} list={`${idPrefix}-brands`} required />
          <datalist id={`${idPrefix}-brands`}>
            {MARKETING_BRANDS.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </label>
        <label className="fldwrap">
          <span className="dim small">Category</span>
          <select className="fld" name="category" defaultValue={item.category}>
            {MARKETING_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="fldwrap">
          <span className="dim small">Type</span>
          <select className="fld" name="type" defaultValue={item.type}>
            <option value="physical">Physical — ships</option>
            <option value="digital">Digital — emailed</option>
          </select>
        </label>
      </div>

      <div className="grid g2" style={{ gap: 10, marginTop: 10 }}>
        <label className="fldwrap">
          <span className="dim small">Specs</span>
          <input className="fld" name="specs" defaultValue={item.specs} placeholder="4 in" />
        </label>
        <label className="fldwrap">
          <span className="dim small">Unit</span>
          <input className="fld" name="unit" defaultValue={item.unit} list={`${idPrefix}-units`} />
          <datalist id={`${idPrefix}-units`}>
            {MARKETING_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="grid g3" style={{ gap: 10, marginTop: 10 }}>
        <label className="fldwrap">
          <span className="dim small">Supplier</span>
          <input className="fld" name="supplier" defaultValue={item.supplier} placeholder="Sticker Mule" />
        </label>
        <label className="fldwrap">
          <span className="dim small">Lead time</span>
          <input className="fld" name="leadTime" defaultValue={item.leadTime} placeholder="Custom order" />
        </label>
        <label className="fldwrap">
          <span className="dim small">Sort</span>
          <input className="fld" name="sortOrder" type="number" defaultValue={item.sortOrder} />
        </label>
      </div>

      <label className="fldwrap" style={{ marginTop: 10, display: "block" }}>
        <span className="dim small">Description — this is what the rep reads</span>
        <textarea className="fld" name="description" defaultValue={item.description} rows={2} style={{ width: "100%" }} />
      </label>

      <label className="fldwrap" style={{ marginTop: 10, display: "block" }}>
        <span className="dim small">Artwork — JPEG, PNG or WebP, 4MB. Leave empty to keep the current image.</span>
        <input className="fld" name="image" type="file" accept="image/jpeg,image/png,image/webp" />
      </label>
    </>
  );
}

export default async function MarketingCatalogPage() {
  await requireOpsUser();

  const items = await db.marketingItem.findMany({
    include: { _count: { select: { lines: true } } },
  });
  items.sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      categoryRank(a.category) - categoryRank(b.category) ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );

  const live = items.filter((i) => i.active).length;

  return (
    <main>
      <div className="hd">
        <h1>Marketing catalogue</h1>
        <p className="sub">
          {live} item{live === 1 ? "" : "s"} orderable from the app right now. Edits reach the field on
          the next catalogue fetch — no deploy. <Link href="/ops/marketing">← Back to requests</Link>
        </p>
      </div>

      <details className="panel" style={{ marginBottom: 16 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Add an item</summary>
        <form action={createItemAction} style={{ marginTop: 12 }}>
          <ItemFields item={EMPTY} idPrefix="new" />
          <button className="btn primary" type="submit" style={{ marginTop: 12 }}>
            Add to catalogue
          </button>
        </form>
      </details>

      <div className="grid">
        {items.map((item) => (
          <details className="panel" key={item.id} style={item.active ? undefined : { opacity: 0.62 }}>
            <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
              {/* A plain <img>: the thumbnail is a 40px preview of artwork whose
                  dimensions we do not know, and which may live either in this
                  app's own /marketing/ folder or in Blob. next/image would
                  need a configured loader for the second. */}
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageUrl}
                  alt=""
                  width={40}
                  height={40}
                  style={{ objectFit: "contain", borderRadius: 6, background: "var(--surface-2)", flex: "none" }}
                />
              ) : (
                <span
                  aria-hidden="true"
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 6,
                    background: "var(--surface-2)",
                    flex: "none",
                  }}
                />
              )}
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{item.name}</b>
                <span className="dim small" style={{ display: "block" }}>
                  <span className="mono">{item.sku}</span> · {item.brand} · {item.category}
                  {item.specs ? ` · ${item.specs}` : ""}
                </span>
              </span>
              <span className="pill">{item.type === "digital" ? "Digital" : "Physical"}</span>
              {item.active ? null : <span className="pill">Retired</span>}
              {item._count.lines ? (
                <span className="dim small">
                  {item._count.lines} order{item._count.lines === 1 ? "" : "s"}
                </span>
              ) : null}
            </summary>

            <form action={updateItemAction} style={{ marginTop: 12 }}>
              <input type="hidden" name="id" value={item.id} />
              <ItemFields item={{ ...item, sortOrder: item.sortOrder }} idPrefix={item.id} />
              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
                <button className="btn primary" type="submit">
                  Save
                </button>
              </div>
            </form>

            {/* Outside the edit form: a nested form is invalid HTML and the
                browser silently drops the inner one. */}
            <form action={setItemActiveAction} style={{ marginTop: 8 }}>
              <input type="hidden" name="id" value={item.id} />
              <input type="hidden" name="active" value={item.active ? "0" : "1"} />
              <button className="btn sm ghost" type="submit">
                {item.active ? "Retire — hides it from the app" : "Un-retire"}
              </button>
            </form>
          </details>
        ))}
      </div>
    </main>
  );
}
