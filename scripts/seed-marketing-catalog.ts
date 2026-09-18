/**
 * Seed the marketing catalogue.
 *
 *   npx tsx scripts/seed-marketing-catalog.ts [--dry-run] [--prune]
 *                                             [--slack-channel C0123456789]
 *
 * The twenty items are the Field Supply Board's, transcribed field for field:
 * sku, name, brand, category, type, description, specs, unit, supplier and
 * lead time all carry over unchanged, so a rep sees the same words in the app
 * that marketing sees on the board.
 *
 * Artwork lives in `public/marketing/<sku>.{jpg,png}` rather than in Vercel
 * Blob, and rather than as the base64 data URIs the board keeps in its own
 * database. Three reasons, in order of how much they matter:
 *
 *   1. The rep app works in cellars and back bars. Images that ship with the
 *      deploy are cached by the service worker with everything else; images
 *      behind a Blob URL are a network request that fails exactly when a rep
 *      needs the catalogue most.
 *   2. A megabyte of base64 in the catalogue response is a megabyte on every
 *      poll, on a phone, on someone's data plan.
 *   3. They are brand artwork, unchanging and public. That is what `public/`
 *      is for.
 *
 * Images ops uploads later from the hub DO go to Blob — see the catalogue
 * editor. `imageUrl` holds either kind, which is why it is a plain string.
 *
 * Re-runnable: items are upserted on `sku`, so running this again corrects
 * copy without touching requests already placed against an item, and without
 * disturbing anything ops has since edited except the fields listed here.
 * `--prune` additionally retires (active = false, never deletes) any catalogue
 * item this file does not name, which is what makes it a true replacement for
 * the old bundled marketing-materials.js rather than an addition to it.
 *
 * `--slack-channel` points the request queue at a Slack channel in the same
 * run. It writes the RegionSlackChannel row that lib/marketing/slack.ts reads
 * first, so it takes effect immediately and without a redeploy — which is the
 * difference between this and setting SLACK_CHANNEL_MARKETING in Vercel. Both
 * work; the row wins. Pass the channel ID (Slack shows it at the bottom of
 * the channel's About tab), not the #name.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { config } from "dotenv";
import type { MarketingItemType } from "../app/generated/prisma/enums";

// tsx does not read .env.local the way the Prisma CLI does, so without this
// every write would go to localhost.
config({ path: ".env.local", quiet: true });

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const PRUNE = args.includes("--prune");
const channelIndex = args.indexOf("--slack-channel");
const SLACK_CHANNEL = channelIndex >= 0 ? args[channelIndex + 1]?.trim() : undefined;

/** Mirrors MARKETING_REGION in lib/marketing/slack.ts: the sentinel for the
 *  one channel that is not regional. A real region name would collide with a
 *  city the order channels already map. */
const MARKETING_REGION = "*";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

interface SeedItem {
  sku: string;
  name: string;
  brand: string;
  category: string;
  type: string;
  description: string;
  specs: string;
  unit: string;
  supplier: string;
  leadTime: string;
  imageUrl: string | null;
  sortOrder: number;
}

const ITEMS: SeedItem[] = [
  {
    sku: "CNT-POS-SELLSHEET",
    name: "Cantinesca Sales Sheet",
    brand: "Cantinesca",
    category: "Sell Sheets",
    type: "physical",
    description: "Sell sheet for Cantinesca with current wholesale pricing.",
    specs: "8.5 × 11 in · ½ BBL $192.00 · ⅙ BBL $96.00 · 2/12/12oz $31.70",
    unit: "pack of 25",
    supplier: "Vistaprint",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-SELLSHEET.jpg",
    sortOrder: 0,
  },
  {
    sku: "SLG-POS-SELLSHEET",
    name: "Sunlight Groove Sales Sheet",
    brand: "Sunlight Groove",
    category: "Sell Sheets",
    type: "physical",
    description: "Sell sheet for Sunlight Groove with current wholesale pricing.",
    specs: "8.5 × 11 in · ½ BBL $205.00 · ⅙ BBL $99.50 · 4/6/12oz $36.25",
    unit: "pack of 25",
    supplier: "Vistaprint",
    leadTime: "",
    imageUrl: "/marketing/SLG-POS-SELLSHEET.jpg",
    sortOrder: 10,
  },
  {
    sku: "CNT-POS-STICKER3",
    name: "Cantinesca Seal Sticker",
    brand: "Cantinesca",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Die-cut circle sticker of the Cantinesca sunburst medallion. Coolers, laptops, to-go bags.",
    specs: "3 × 3 in",
    unit: "each",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-STICKER3.png",
    sortOrder: 0,
  },
  {
    sku: "CNT-POS-WORDMARK",
    name: "Cantinesca Wordmark Sticker",
    brand: "Cantinesca",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Die-cut vinyl sticker of the Cantinesca wordmark, no medallion. Clean logo placement for coolers and signage.",
    specs: "5 × 1.39 in",
    unit: "each",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-WORDMARK.png",
    sortOrder: 10,
  },
  {
    sku: "SLG-POS-STICKER",
    name: "Sunlight Groove Sticker",
    brand: "Sunlight Groove",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Die-cut sticker of the Sunlight Groove pour girl above the wordmark lockup. Coolers, laptops, to-go bags.",
    specs: "2.6 × 3 in",
    unit: "each",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/SLG-POS-STICKER.png",
    sortOrder: 20,
  },
  {
    sku: "SLG-POS-WORDMARK",
    name: "Sunlight Groove Wordmark Sticker",
    brand: "Sunlight Groove",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Die-cut vinyl sticker of the Sunlight Groove wordmark, no character art. Clean logo placement for coolers and signage.",
    specs: "3 × 1.72 in",
    unit: "each",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/SLG-POS-WORDMARK.png",
    sortOrder: 30,
  },
  {
    sku: "TLM-SWAG-HOLOSTICK",
    name: "The Leopard Mark Holographic Crest Sticker",
    brand: "The Leopard Mark",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Die-cut holographic sticker of The Leopard Mark heraldic crest. Rainbow-shift foil finish.",
    specs: "2.17 × 3 in",
    unit: "each",
    supplier: "Sticker Mule",
    leadTime: "Custom order, ships in 7-10 business days",
    imageUrl: "/marketing/TLM-SWAG-HOLOSTICK.png",
    sortOrder: 40,
  },
  {
    sku: "TLM-SWAG-POLOBLK",
    name: "The Leopard Mark Staff Polo, Black",
    brand: "The Leopard Mark",
    category: "Apparel & Accessories",
    type: "physical",
    description: "Black polo with The Leopard Mark crest printed on the front-left chest. Staff & trade-show apparel.",
    specs: "TT51 Men's Zone Performance Polo · XS–3XL",
    unit: "each",
    supplier: "Rush Order Tees",
    leadTime: "Custom order, ships in 7-10 business days",
    imageUrl: "/marketing/TLM-SWAG-POLOBLK.jpg",
    sortOrder: 50,
  },
  {
    sku: "TLM-SWAG-POLOWHT",
    name: "The Leopard Mark Staff Polo, White",
    brand: "The Leopard Mark",
    category: "Apparel & Accessories",
    type: "physical",
    description: "White polo with The Leopard Mark crest printed on the front-left chest. Staff & trade-show apparel.",
    specs: "TT51 Men's Zone Performance Polo · XS–3XL",
    unit: "each",
    supplier: "Rush Order Tees",
    leadTime: "Custom order, ships in 7-10 business days",
    imageUrl: "/marketing/TLM-SWAG-POLOWHT.jpg",
    sortOrder: 60,
  },
  {
    sku: "CNT-POS-AFRAME",
    name: "Cantinesca A-Frame Poster",
    brand: "Cantinesca",
    category: "Banners & Signage",
    type: "physical",
    description: "A-frame poster with the full Cantinesca lockup: cans, tap handle and glass. Greets guests at the door.",
    specs: "24 × 36 in",
    unit: "each",
    supplier: "Vistaprint",
    leadTime: "Custom order",
    imageUrl: "/marketing/CNT-POS-AFRAME.jpg",
    sortOrder: 0,
  },
  {
    sku: "CNT-POS-BACKDROP",
    name: "Cantinesca Vinyl Backdrop",
    brand: "Cantinesca",
    category: "Banners & Signage",
    type: "physical",
    description: "Step-and-repeat style vinyl backdrop for tastings, launches and photo moments.",
    specs: "6 × 10 ft",
    unit: "each",
    supplier: "Vistaprint",
    leadTime: "Custom order",
    imageUrl: "/marketing/CNT-POS-BACKDROP.jpg",
    sortOrder: 10,
  },
  {
    sku: "CNT-POS-TENT10",
    name: "Cantinesca Canopy Tent Cover",
    brand: "Cantinesca",
    category: "Table & Event Displays",
    type: "physical",
    description: "Canopy tent cover, full-color Cantinesca print on both faces. Outdoor pours and festivals.",
    specs: "10 × 10 ft",
    unit: "each",
    supplier: "Vistaprint",
    leadTime: "Custom order",
    imageUrl: "/marketing/CNT-POS-TENT10.jpg",
    sortOrder: 0,
  },
  {
    sku: "CNT-POS-COAST4",
    name: "Cantinesca Coaster",
    brand: "Cantinesca",
    category: "Table & Event Displays",
    type: "physical",
    description: "Pulpboard coaster with the full Cantinesca medallion. Bar-top standard.",
    specs: "4 in",
    unit: "pack of 250",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-COAST4.png",
    sortOrder: 10,
  },
  {
    sku: "CNT-POS-CLOTH8",
    name: "Cantinesca Table Cloth",
    brand: "Cantinesca",
    category: "Table & Event Displays",
    type: "physical",
    description: "Table cloth in the full Cantinesca pattern and wordmark. Festivals, tastings, account events.",
    specs: "8 ft, four-sided fitted",
    unit: "each",
    supplier: "Vistaprint",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-CLOTH8.jpg",
    sortOrder: 20,
  },
  {
    sku: "SLG-POS-COAST4",
    name: "Sunlight Groove Coaster",
    brand: "Sunlight Groove",
    category: "Table & Event Displays",
    type: "physical",
    description: "Pulpboard coaster with the full Sunlight Groove Golden Gate medallion. Bar-top standard.",
    specs: "4 in",
    unit: "pack of 250",
    supplier: "Sticker Mule",
    leadTime: "",
    imageUrl: "/marketing/SLG-POS-COAST4.png",
    sortOrder: 30,
  },
  {
    sku: "CNT-POS-TAP",
    name: "Cantinesca Draft Tap Handle",
    brand: "Cantinesca",
    category: "Draft & On-Premise",
    type: "physical",
    description: "Full-color, shaped draft tap handle topped with the Leopard Mark crest. For back-bar presence.",
    specs: "",
    unit: "each",
    supplier: "Leopard Mark Trade Marketing",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-TAP.png",
    sortOrder: 0,
  },
  {
    sku: "CNT-POS-GLASS16",
    name: "Cantinesca Etched Pint Glass",
    brand: "Cantinesca",
    category: "Draft & On-Premise",
    type: "physical",
    description: "Etched shaker pint glass with the Cantinesca medallion. Standard on-premise pour glass.",
    specs: "16 oz",
    unit: "case of 24",
    supplier: "Leopard Mark Trade Marketing",
    leadTime: "",
    imageUrl: "/marketing/CNT-POS-GLASS16.jpg",
    sortOrder: 10,
  },
  {
    sku: "CNT-DIG-LOGO",
    name: "Cantinesca Brand & Logo Pack",
    brand: "Cantinesca",
    category: "Logos & Brand Marks",
    type: "digital",
    description: "Cantinesca wordmark and Cerveza lockup, can and tap art, plus the Leopard Mark heritage seal for co-branded use.",
    specs: "Vector + PNG",
    unit: "digital download",
    supplier: "Marketing Team",
    leadTime: "Delivered by email within 1 business day",
    imageUrl: "/marketing/CNT-DIG-LOGO.png",
    sortOrder: 0,
  },
  {
    sku: "SLG-DIG-LOGO",
    name: "Sunlight Groove Brand & Logo Pack",
    brand: "Sunlight Groove",
    category: "Logos & Brand Marks",
    type: "digital",
    description: "Sunlight Groove wordmark lockup and mascot line art, plus the Leopard Mark heritage seal for co-branded use.",
    specs: "Vector + PNG",
    unit: "digital download",
    supplier: "Marketing Team",
    leadTime: "Delivered by email within 1 business day",
    imageUrl: "/marketing/SLG-DIG-LOGO.png",
    sortOrder: 10,
  },
  {
    sku: "CNT-DIG-DECK",
    name: "Cantinesca Distributor Pitch Deck",
    brand: "Cantinesca",
    category: "Sales Decks",
    type: "digital",
    description: "Full launch deck: heritage story, category opportunity, national accounts, supply chain, brand philosophy, taste profile and formats.",
    specs: "PDF + PowerPoint",
    unit: "digital download",
    supplier: "Marketing Team",
    leadTime: "Delivered by email within 1 business day",
    imageUrl: "/marketing/CNT-DIG-DECK.jpg",
    sortOrder: 0,
  },];

async function main(): Promise<void> {
  console.log(`${DRY_RUN ? "[dry run] " : ""}Seeding ${ITEMS.length} marketing items…`);

  let created = 0;
  let updated = 0;

  for (const item of ITEMS) {
    const existing = await db.marketingItem.findUnique({ where: { sku: item.sku }, select: { id: true } });
    if (DRY_RUN) {
      console.log(`  ${existing ? "update" : "create"}  ${item.sku.padEnd(20)} ${item.name}`);
      if (existing) updated++;
      else created++;
      continue;
    }

    const data = {
      name: item.name,
      brand: item.brand,
      category: item.category,
      type: item.type as MarketingItemType,
      description: item.description,
      specs: item.specs,
      unit: item.unit,
      supplier: item.supplier,
      leadTime: item.leadTime,
      imageUrl: item.imageUrl,
      sortOrder: item.sortOrder,
    };

    await db.marketingItem.upsert({
      where: { sku: item.sku },
      // `active` is set on create only. An item ops has deliberately retired
      // must not come back to life because someone re-ran the seed.
      create: { sku: item.sku, active: true, ...data },
      update: data,
    });
    if (existing) updated++;
    else created++;
  }

  if (PRUNE) {
    const keep = ITEMS.map((i) => i.sku);
    const stale = await db.marketingItem.findMany({
      where: { sku: { notIn: keep }, active: true },
      select: { sku: true, name: true },
    });
    if (stale.length) {
      console.log(`\n${DRY_RUN ? "[dry run] " : ""}Retiring ${stale.length} item(s) not in this file:`);
      for (const s of stale) console.log(`  retire  ${s.sku.padEnd(20)} ${s.name}`);
      if (!DRY_RUN) {
        await db.marketingItem.updateMany({ where: { sku: { notIn: keep } }, data: { active: false } });
      }
    }
  }

  // The one non-catalogue write this script makes. Deliberately after the
  // items: a channel pointed at an empty catalogue would announce requests
  // for things nobody can order.
  if (SLACK_CHANNEL) {
    console.log(`\n${DRY_RUN ? "[dry run] " : ""}Marketing requests -> Slack channel ${SLACK_CHANNEL}`);
    if (!DRY_RUN) {
      await db.regionSlackChannel.upsert({
        where: { region: MARKETING_REGION },
        create: { region: MARKETING_REGION, channelId: SLACK_CHANNEL, purpose: "marketing" },
        update: { channelId: SLACK_CHANNEL, purpose: "marketing" },
      });
    }
  }

  console.log(`\n${DRY_RUN ? "[dry run] " : ""}Done. ${created} created, ${updated} updated.`);
  if (DRY_RUN) console.log("Nothing was written. Re-run without --dry-run to apply.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await pool.end();
  });
