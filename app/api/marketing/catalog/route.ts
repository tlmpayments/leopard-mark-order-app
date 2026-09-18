import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentOpsUser } from "@/lib/ops/session";
import { repTokenFromRequest, verifyRepToken } from "@/lib/prospects/repToken";
import { categoryRank, MARKETING_CATEGORIES, MARKETING_PURPOSES } from "@/lib/marketing/catalog";

/**
 * The catalogue the rep app renders.
 *
 * This replaces assets/js/marketing-materials.js, which was 31 items compiled
 * into the bundle. The reason it is an endpoint now and not a file: ops edits
 * the catalogue in the hub, and a bundled file meant every correction — a
 * changed supplier, a retired item, a new sell sheet — was a deploy. Reps were
 * ordering things that had been discontinued because nobody ships a PWA to fix
 * a typo.
 *
 * Read-only and deliberately generous about who may call it. A rep with a
 * token gets it; so does anyone signed into the hub, which is what lets the
 * ops catalogue editor preview exactly what the field sees. There is nothing
 * confidential in a list of stickers.
 */

export const dynamic = "force-dynamic";

/** Anyone who may see the catalogue. The rep app is the main caller. */
async function caller(request: Request): Promise<string | null> {
  const rep = verifyRepToken(repTokenFromRequest(request));
  if (rep) return rep.rep;
  const opsUser = await currentOpsUser();
  return opsUser?.name ?? null;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await caller(request))) {
    return NextResponse.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  const items = await db.marketingItem.findMany({
    where: { active: true },
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      category: true,
      type: true,
      description: true,
      specs: true,
      unit: true,
      supplier: true,
      leadTime: true,
      imageUrl: true,
      updatedAt: true,
    },
  });

  // Sorted here rather than in the query because the category order is the
  // app's list, not alphabetical — "Sell Sheets" leads because that is what a
  // rep reaches for most, and Postgres has no opinion about that.
  items.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.category.localeCompare(b.category) ||
      a.name.localeCompare(b.name),
  );

  // The brand filter is built from what is actually in stock rather than from
  // MARKETING_BRANDS: a chip for a brand with nothing behind it is a chip that
  // filters to an empty screen.
  const brands = [...new Set(items.map((i) => i.brand))].sort();

  return NextResponse.json({
    ok: true,
    // Bumped whenever any item changes, so the rep app's cached copy can be
    // compared without shipping the whole catalogue to check.
    version: items.reduce((max, i) => Math.max(max, i.updatedAt.getTime()), 0),
    categories: MARKETING_CATEGORIES,
    brands,
    purposes: MARKETING_PURPOSES,
    items: items.map((i) => ({
      id: i.id,
      sku: i.sku,
      name: i.name,
      brand: i.brand,
      category: i.category,
      type: i.type,
      description: i.description,
      specs: i.specs,
      unit: i.unit,
      supplier: i.supplier,
      leadTime: i.leadTime,
      imageUrl: i.imageUrl,
    })),
  });
}
