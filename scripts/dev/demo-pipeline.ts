/**
 * Development-only: drive one order through the whole pipeline using the real
 * services, and print what actually happened at each step.
 *
 * This is the §10 acceptance evidence for P2–P4 in runnable form: confirm →
 * propose → schedule → deliver, with the BOL minted from the real counter, the
 * ledger written, keg custody moved, and the stage derived rather than stored.
 *
 * Never point this at production. It writes orders.
 *
 *   DATABASE_URL=<local> npx tsx scripts/dev/demo-pipeline.ts
 */

import { PrismaClient } from "../../app/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ulid } from "ulid";
import bcrypt from "bcryptjs";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PrismaClient({ adapter: new PrismaPg(pool) });

if (/neon\.tech|amazonaws/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run against a hosted database. Use a local prisma dev server.");
  process.exit(1);
}

async function main() {
  // ---- An admin who can sign in ----
  const admin = await db.rep.upsert({
    where: { name: "Jack Begley" },
    create: { name: "Jack Begley", role: "admin", pinHash: await bcrypt.hash("1234", 10), active: true },
    update: { role: "admin", pinHash: await bcrypt.hash("1234", 10), active: true },
  });
  // One of each remaining role, so the role gating is demonstrable.
  const roles: Array<["ops" | "warehouse" | "docs_only", string]> = [
    ["ops", "Dany"],
    ["warehouse", "Warehouse — Benicia"],
    ["docs_only", "Daniel"],
  ];
  for (const [role, name] of roles) {
    const rep = await db.rep.upsert({
      where: { name },
      create: { name, role, pinHash: await bcrypt.hash("1234", 10), active: true },
      update: { role, pinHash: await bcrypt.hash("1234", 10), active: true },
    });
    if (role === "warehouse") {
      await db.userLocation.upsert({
        where: { userId_locationId: { userId: rep.id, locationId: "WH-BEN" } },
        create: { userId: rep.id, locationId: "WH-BEN" },
        update: {},
      });
    }
  }
  console.log("Users: admin/ops/warehouse/docs_only, all PIN 1234");

  // ---- Stock into the warehouses, so the stock check has something to check ----
  const products = await db.product.findMany({ where: { active: true } });
  const existingEvents = await db.inventoryEvent.count();
  if (existingEvents === 0) {
    for (const p of products) {
      for (const wh of ["WH-BEN", "WH-SF", "WH-WIL"]) {
        await db.inventoryEvent.create({
          data: {
            occurredAt: new Date(Date.now() - 10 * 86_400_000),
            type: "INCOMING",
            productId: p.id,
            qty: 24,
            toLocationId: wh,
            refNote: "demo opening stock",
            importRef: `demo:${p.skuCode}:${wh}`,
          },
        });
      }
    }
    console.log(`Stock: seeded ${products.length * 3} INCOMING events (24 each at 3 warehouses)`);
  }

  const stock = await db.$queryRaw<Array<{ sku_code: string; location_id: string; on_hand: bigint }>>`
    SELECT p."sku_code", s."location_id", s."on_hand"
    FROM "stock_by_location" s JOIN "products" p ON p."id" = s."product_id"
    ORDER BY p."sku_code", s."location_id" LIMIT 4`;
  console.log("stock_by_location says:", stock.map((r) => `${r.sku_code}@${r.location_id}=${r.on_hand}`).join(" "));

  // ---- Orders at every stage ----
  const accounts = await db.account.findMany({ take: 6, orderBy: { businessName: "asc" } });
  if (accounts.length < 4) {
    console.error("Need at least 4 accounts. Run scripts/import-foundation-data.ts first.");
    process.exit(1);
  }
  // Give the accounts what stage ① needs, so the checklist is meaningful.
  for (const [i, a] of accounts.entries()) {
    await db.account.update({
      where: { id: a.id },
      data: {
        region: i % 2 === 0 ? "BA" : "LA",
        terms: "Net 30",
        paymentMethod: "ACH",
        licenseStatus: i === 3 ? "expired" : "active",
        licenseNumber: a.licenseNumber ?? `54${1000 + i}`,
        // One account deliberately has no billing email, to demonstrate the
        // missing-billing-email block at ⑤ rather than describing it.
        billingContactEmail: i === 2 ? null : `ap@${a.businessName.toLowerCase().replace(/[^a-z]+/g, "")}.example`,
        approvalStatus: "approved",
      },
    });
  }

  const { scheduleOrder, proposeSlot } = await import("../../lib/scheduling");
  const { markDelivered } = await import("../../lib/delivery");
  const { appendOrderEvent, blockOrder } = await import("../../lib/orderEvents");
  const { pipelineStage } = await import("../../lib/pipeline");

  // Re-runnable: continue the invoice series past whatever is already there
  // rather than colliding with it. orders.invoice_number is UNIQUE, and a demo
  // script that only works on an empty database is a demo script nobody runs
  // twice.
  // Only strictly-numeric INV##### numbers count: the test fixtures also write
  // things like "INV-<random>", and a lexicographic max over both yields NaN,
  // which then collides on every insert.
  const numbered = await db.$queryRaw<Array<{ max: number | null }>>`
    SELECT MAX(SUBSTRING("invoice_number" FROM 4)::int) AS "max"
    FROM "orders"
    WHERE "invoice_number" ~ '^INV[0-9]+$'`;
  let invoiceSeq = Math.max(26290, (numbered[0]?.max ?? 0) + 1);
  const made: string[] = [];

  async function createOrder(accountIndex: number, skus: string[], qty: number) {
    const account = accounts[accountIndex];
    const id = ulid();
    const lines = skus
      .map((sku) => products.find((p) => p.skuCode === sku))
      .filter((p): p is NonNullable<typeof p> => Boolean(p));
    if (lines.length === 0) throw new Error(`No products matched ${skus.join(",")}`);

    await db.order.create({
      data: {
        id,
        accountId: account.id,
        channel: "rep_app",
        status: "confirmed",
        submittedAt: new Date(Date.now() - 3 * 86_400_000),
        confirmedAt: new Date(Date.now() - 3 * 86_400_000),
        salesRepId: admin.id,
        invoiceNumber: `INV${invoiceSeq++}`,
        inventorySource: account.region === "BA" ? "WH-BEN" : "WH-WIL",
        paymentMethod: "ACH",
        expectedEmptyKegs: 1,
        lines: {
          create: lines.map((p, idx) => ({
            productId: p.id,
            qty,
            unitPrice: p.listPrice,
            lineTotal: p.listPrice.mul(qty),
            lineIndex: idx,
          })),
        },
      },
    });
    await appendOrderEvent({ orderId: id, eventType: "order.confirmed", actor: "rep", payload: { channel: "rep_app" } });
    made.push(id);
    return id;
  }

  // ② New order, untriaged.
  const newOrder = await createOrder(0, ["CNT1AKHB01"], 2);

  // ③ Needs scheduling — a proposal exists.
  const needsSched = await createOrder(1, ["CNT1AKSB01", "CNT1AC1224"], 3);
  const proposal = await proposeSlot(needsSched);
  console.log(`Proposed slot: ${proposal ? `${proposal.at.toISOString().slice(0, 10)} from ${proposal.warehouseId}` : "none"}`);

  // ④ Scheduled.
  const scheduled = await createOrder(2, ["SGB1AKHB01"], 2);
  await scheduleOrder({
    orderId: scheduled,
    scheduledFor: new Date(Date.now() + 86_400_000),
    warehouseId: "WH-BEN",
    carrierName: "Self (Dany)",
    actor: "ops",
    byUserId: admin.id,
  });

  // Blocked overlay on a scheduled order, to show blocked is not a column.
  const blocked = await createOrder(3, ["CNT1AKSB01"], 1);
  await scheduleOrder({
    orderId: blocked,
    scheduledFor: new Date(Date.now() + 2 * 86_400_000),
    warehouseId: "WH-WIL",
    actor: "ops",
    byUserId: admin.id,
  });
  await blockOrder(blocked, "license_expired", "system", undefined, { expiredOn: "2026-08-28" });

  // ⑤ Delivered — the real transition. Mints the BOL, writes the ledger.
  const toDeliver = await createOrder(4, ["CNT1AKHB01", "CNT1AKSB01"], 2);
  await scheduleOrder({
    orderId: toDeliver,
    scheduledFor: new Date(Date.now() - 86_400_000),
    warehouseId: "WH-BEN",
    carrierName: "Self",
    actor: "ops",
    byUserId: admin.id,
  });
  const kegProduct = products.find((p) => p.skuCode === "CNT1AKSB01")!;
  const delivered = await markDelivered({
    orderId: toDeliver,
    deliveredByUserId: admin.id,
    actor: "ops",
    emptiesByProductId: { [kegProduct.id]: 1 },
    carrierName: "Self",
  });
  console.log(
    `Marked delivered: BOL ${delivered.bolNumber}, ${delivered.inventoryEventCount} ledger events, custody ${delivered.custodyDelta >= 0 ? "+" : ""}${delivered.custodyDelta}, invoice enqueued: ${delivered.invoiceEnqueued}`,
  );

  // ---- Concurrency: parallel mints must produce distinct BOL numbers ----
  // Kept to 8 here because a local prisma dev server has a small connection
  // ceiling and this script's job is to show the pipeline, not to stress the
  // pool. The exhaustive concurrency assertion lives in
  // __tests__/bol-sequence.test.ts.
  const { mintBolNumber } = await import("../../lib/bol/sequence");
  const minted = await Promise.all(
    Array.from({ length: 8 }, () => db.$transaction((tx) => mintBolNumber(tx, "WH-SF"))),
  );
  const distinct = new Set(minted);
  console.log(`BOL concurrency: 8 parallel mints produced ${distinct.size} distinct numbers`);
  console.log(`  sample: ${minted.slice(0, 3).join(", ")}`);
  if (distinct.size !== minted.length) throw new Error("BOL sequence produced a duplicate under concurrency");

  // ---- Print the derived stage for every order ----
  console.log("\nDerived pipeline stages:");
  for (const id of [newOrder, needsSched, scheduled, blocked, toDeliver]) {
    const o = await db.order.findUniqueOrThrow({ where: { id }, include: { invoice: true, account: true } });
    const prop = await (await import("../../lib/scheduling")).currentProposal(id);
    const stage = pipelineStage({
      status: o.status,
      createdAt: o.createdAt,
      submittedAt: o.submittedAt,
      confirmedAt: o.confirmedAt,
      scheduledFor: o.scheduledFor,
      deliveredAt: o.deliveredAt,
      blockedReason: o.blockedReason,
      blockedAt: o.blockedAt,
      proposedSlotAt: prop?.at ?? null,
      invoice: o.invoice,
    });
    console.log(
      `  ${o.invoiceNumber}  ${stage.stage.padEnd(18)}${stage.blockedReason ? `(${stage.blockedReason}, at ${stage.underlyingStage}) ` : ""}${o.account.businessName}`,
    );
  }

  // ---- Keg custody moved ----
  const custody = await db.$queryRaw<Array<{ business_name: string; sku_code: string; balance: bigint }>>`
    SELECT a."business_name", p."sku_code", SUM(k."delta")::bigint AS balance
    FROM "keg_custody_entries" k
    JOIN "accounts" a ON a."id" = k."account_id"
    JOIN "products" p ON p."id" = k."product_id"
    GROUP BY a."business_name", p."sku_code" HAVING SUM(k."delta") <> 0`;
  console.log("\nKeg custody:", custody.map((c) => `${c.business_name}/${c.sku_code}=${c.balance}`).join(" "));

  // ---- Stock after the delivery ----
  const after = await db.$queryRaw<Array<{ sku_code: string; on_hand: bigint; available: bigint }>>`
    SELECT p."sku_code", v."on_hand", v."available"
    FROM "available_for_delivery" v JOIN "products" p ON p."id" = v."product_id"
    WHERE v."location_id" = 'WH-BEN' ORDER BY p."sku_code"`;
  console.log("WH-BEN after delivery:", after.map((r) => `${r.sku_code} on_hand=${r.on_hand} available=${r.available}`).join(" | "));

  const jobs = await db.jobRun.findMany({ select: { kind: true, idempotencyKey: true, status: true } });
  console.log("\nQueued jobs:", jobs.map((j) => `${j.kind}(${j.status})`).join(" "));
  console.log(`\nCreated ${made.length} demo orders.`);

  await db.$disconnect();
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await db.$disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(1);
});
