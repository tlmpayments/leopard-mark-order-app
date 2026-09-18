/**
 * Dispatch: building a route, putting it on the road, and completing it.
 *
 * Three things here are worth a real database rather than a unit test:
 *
 *   - Re-sequencing runs against a `@@unique([routeId, sequence])` constraint,
 *     so "does the swap work" is a question about Postgres, not about the
 *     JavaScript.
 *   - Dispatch mints from the same locked BOL counter the ledger uses. A test
 *     with a mocked counter would prove nothing about the thing that matters.
 *   - The whole point of moving the mint to dispatch is that `markDelivered`
 *     reuses that number instead of taking a second one. That invariant spans
 *     two modules and two transactions.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@/app/generated/prisma/client";
import { testDb, closeTestDb } from "./helpers";
import {
  addStopToRoute,
  createRoute,
  dispatchRoute,
  failStop,
  loadRoute,
  moveStop,
  removeStopFromRoute,
  routeDateValue,
  setExternalBolNumber,
  todayYmd,
  ymdOfRoute,
} from "@/lib/routes";
import { markDelivered, parseDeliveredLines } from "@/lib/delivery";

const suffix = () => Math.random().toString(36).slice(2, 10);

/** A warehouse, an account in the Bay Area, a keg SKU, and N orders on it. */
async function fixture(orderCount = 2) {
  const s = suffix();
  const warehouse = await testDb.location.create({
    data: { id: `WH-T${s.slice(0, 5)}`, name: `Test Warehouse ${s}`, type: "warehouse", city: "SF", state: "CA" },
  });
  const driver = await testDb.rep.create({ data: { name: `Test Driver ${s}`, role: "driver" } });
  const product = await testDb.product.create({
    data: {
      skuCode: `SKU-${s}`,
      productName: "Cantinesca",
      formatLabel: "1/2 Barrel Keg",
      formatDetail: "15.5 gal",
      unit: "keg",
      isKeg: true,
      listPrice: new Prisma.Decimal(192),
      depositAmount: new Prisma.Decimal(50),
    },
  });

  const orders = [];
  for (let i = 0; i < orderCount; i += 1) {
    const account = await testDb.account.create({
      data: { businessName: `Bar ${s}-${i}`, region: "San Francisco", deliveryAddress: `${i} Test St, SF` },
    });
    const order = await testDb.order.create({
      data: {
        id: `ORD-${s}-${i}`,
        accountId: account.id,
        channel: "rep_app",
        status: "confirmed",
        confirmedAt: new Date(),
        inventorySource: warehouse.id,
      },
    });
    await testDb.orderLine.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: 2,
        unitPrice: new Prisma.Decimal(192),
        lineTotal: new Prisma.Decimal(384),
        lineIndex: 0,
      },
    });
    orders.push({ order, account });
  }

  const route = await createRoute({
    ymd: todayYmd(),
    region: "BA",
    warehouseId: warehouse.id,
    driverId: driver.id,
    name: `T${s.slice(0, 4)}`,
  });

  return { route, warehouse, driver, product, orders };
}

afterAll(async () => {
  await closeTestDb();
});

describe("building a route", () => {
  it("appends stops in the order they are added", async () => {
    const f = await fixture(3);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);

    const route = await loadRoute(f.route.id);
    expect(route!.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(route!.stops.map((s) => s.orderId)).toEqual(f.orders.map((o) => o.order.id));
  });

  it("schedules the order onto the route's day and warehouse", async () => {
    const f = await fixture(1);
    const { order } = f.orders[0];
    expect(order.scheduledFor).toBeNull();

    await addStopToRoute(f.route.id, order.id);

    const after = await testDb.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("scheduled");
    expect(after.inventorySource).toBe(f.warehouse.id);
    // Scheduled for the route's own calendar day in Pacific terms.
    expect(after.scheduledFor).not.toBeNull();
    const scheduledYmd = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(after.scheduledFor!);
    expect(scheduledYmd).toBe(ymdOfRoute(f.route.date));
  });

  it("refuses to put one order on two routes", async () => {
    const f = await fixture(1);
    const other = await createRoute({
      ymd: todayYmd(),
      region: "BA",
      warehouseId: f.warehouse.id,
      driverId: f.driver.id,
    });
    await addStopToRoute(f.route.id, f.orders[0].order.id);

    await expect(addStopToRoute(other.id, f.orders[0].order.id)).rejects.toThrow(/already/i);
  });

  it("swaps two stops without tripping the unique sequence constraint", async () => {
    const f = await fixture(3);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);
    const before = await loadRoute(f.route.id);

    await moveStop(before!.stops[2].id, "up");

    const after = await loadRoute(f.route.id);
    expect(after!.stops.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(after!.stops.map((s) => s.orderId)).toEqual([
      f.orders[0].order.id,
      f.orders[2].order.id,
      f.orders[1].order.id,
    ]);
  });

  it("closes the gap when a stop is removed", async () => {
    const f = await fixture(3);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);
    const before = await loadRoute(f.route.id);

    await removeStopFromRoute(before!.stops[0].id);

    const after = await loadRoute(f.route.id);
    expect(after!.stops.map((s) => s.sequence)).toEqual([1, 2]);
    expect(after!.stops[0].orderId).toBe(f.orders[1].order.id);
  });

  it("will not dispatch a route with no driver", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await testDb.deliveryRoute.update({ where: { id: f.route.id }, data: { driverId: null } });

    await expect(dispatchRoute(f.route.id, "tester")).rejects.toThrow(/driver/i);
  });

  it("will not dispatch an empty route", async () => {
    const f = await fixture(0);
    await expect(dispatchRoute(f.route.id, "tester")).rejects.toThrow(/no stops/i);
  });
});

describe("dispatch", () => {
  it("mints one distinct BOL number per stop and marks the shipments in transit", async () => {
    const f = await fixture(3);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);

    const result = await dispatchRoute(f.route.id, f.driver.id);

    expect(result.stopCount).toBe(3);
    expect(new Set(result.bolNumbers).size).toBe(3);
    for (const n of result.bolNumbers) {
      expect(n).toMatch(new RegExp(`^BOL-${f.warehouse.id}-\\d{6}-\\d{2,}$`));
    }

    const shipments = await testDb.shipment.findMany({
      where: { orderId: { in: f.orders.map((o) => o.order.id) } },
    });
    expect(shipments).toHaveLength(3);
    expect(shipments.every((s) => s.status === "in_transit")).toBe(true);
    expect(shipments.every((s) => s.bolNumber)).toBe(true);

    // The Sheet-facing column on the order carries it too, so the mirror job
    // has something to write.
    const orders = await testDb.order.findMany({ where: { id: { in: f.orders.map((o) => o.order.id) } } });
    expect(orders.every((o) => o.bolNumber)).toBe(true);

    const route = await testDb.deliveryRoute.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(route.status).toBe("dispatched");
    expect(route.dispatchedAt).not.toBeNull();
  });

  it("is idempotent — a second dispatch mints nothing new", async () => {
    const f = await fixture(2);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);

    const first = await dispatchRoute(f.route.id, f.driver.id);
    const second = await dispatchRoute(f.route.id, f.driver.id);

    expect(second.alreadyDispatched).toBe(true);
    expect([...second.bolNumbers].sort()).toEqual([...first.bolNumbers].sort());
  });

  it("mints paperwork for a stop added after the route left", async () => {
    const f = await fixture(2);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await dispatchRoute(f.route.id, f.driver.id);

    await addStopToRoute(f.route.id, f.orders[1].order.id);

    const late = await testDb.shipment.findFirstOrThrow({ where: { orderId: f.orders[1].order.id } });
    expect(late.bolNumber).toBeTruthy();
    expect(late.status).toBe("in_transit");
  });
});

describe("delivery after dispatch", () => {
  it("keeps the BOL number the driver is carrying", async () => {
    const f = await fixture(1);
    const { order } = f.orders[0];
    await addStopToRoute(f.route.id, order.id);
    const { bolNumbers } = await dispatchRoute(f.route.id, f.driver.id);
    const dispatched = bolNumbers[0];

    const result = await markDelivered({
      orderId: order.id,
      deliveredByUserId: f.driver.id,
      actor: "ops",
    });

    // The number on the retailer's signed copy is the number in the ledger.
    expect(result.bolNumber).toBe(dispatched);

    const shipment = await testDb.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(shipment.bolNumber).toBe(dispatched);
    expect(shipment.status).toBe("delivered");

    // And exactly one number was ever taken from the counter for it.
    const events = await testDb.orderEvent.findMany({
      where: { orderId: order.id, eventType: "bol.issued" },
    });
    const issued = new Set(events.map((e) => (e.payloadJson as { bolNumber?: string }).bolNumber));
    expect(issued).toEqual(new Set([dispatched]));
  });

  it("writes the ledger and keg custody, and settles the route when the last stop lands", async () => {
    const f = await fixture(2);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);
    await dispatchRoute(f.route.id, f.driver.id);
    const route = await loadRoute(f.route.id);

    for (const stop of route!.stops) {
      await markDelivered({ orderId: stop.orderId!, deliveredByUserId: f.driver.id, actor: "ops" });
      await testDb.routeStop.update({
        where: { id: stop.id },
        data: { status: "delivered", completedAt: new Date() },
      });
    }
    const { settleRouteStatus } = await import("@/lib/routes");
    await settleRouteStatus(f.route.id);

    const after = await testDb.deliveryRoute.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();

    const custody = await testDb.kegCustodyEntry.findMany({
      where: { accountId: { in: f.orders.map((o) => o.account.id) } },
    });
    expect(custody.reduce((n, c) => n + c.delta, 0)).toBe(4); // 2 kegs × 2 accounts
  });

  it("records a failed stop without delivering anything", async () => {
    const f = await fixture(2);
    for (const { order } of f.orders) await addStopToRoute(f.route.id, order.id);
    await dispatchRoute(f.route.id, f.driver.id);
    const route = await loadRoute(f.route.id);

    await failStop(route!.stops[0].id, "closed", { notes: "Nobody there at 9am" });

    const stop = await testDb.routeStop.findUniqueOrThrow({ where: { id: route!.stops[0].id } });
    expect(stop.status).toBe("failed");
    expect(stop.failureReason).toBe("closed");

    const order = await testDb.order.findUniqueOrThrow({ where: { id: route!.stops[0].orderId! } });
    expect(order.deliveredAt).toBeNull();
    expect(order.status).toBe("scheduled");

    // One stop touched, one still pending: the route is under way, not done.
    const after = await testDb.deliveryRoute.findUniqueOrThrow({ where: { id: f.route.id } });
    expect(after.status).toBe("in_progress");
  });

  it("refuses to remove a stop that has already been delivered", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await dispatchRoute(f.route.id, f.driver.id);
    const route = await loadRoute(f.route.id);
    await testDb.routeStop.update({ where: { id: route!.stops[0].id }, data: { status: "delivered" } });

    await expect(removeStopFromRoute(route!.stops[0].id)).rejects.toThrow(/delivered/i);
  });
});

describe("route day storage", () => {
  it("round-trips a Pacific calendar day through the DATE column", () => {
    const value = routeDateValue("2026-11-01"); // the DST fall-back day
    expect(ymdOfRoute(value)).toBe("2026-11-01");
  });
});

describe("parseDeliveredLines", () => {
  /**
   * The regression this exists for: qty and lot for the same line used to
   * produce two entries, and `markDelivered` keys overrides by line id, so
   * whichever arrived last won. Both forms post qty before lot, so the lot
   * entry silently erased the driver's corrected quantity and the invoice
   * billed what was ordered.
   */
  it("merges qty and lot for the same line into one override", () => {
    const fd = new FormData();
    fd.set("qty[line-1]", "1");
    fd.set("lot[line-1]", "L26CNT08");

    const { lines } = parseDeliveredLines(fd);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ orderLineId: "line-1", actualQty: 1, lotNumber: "L26CNT08" });
  });

  it("merges them in either field order", () => {
    const fd = new FormData();
    fd.set("lot[line-1]", "L26CNT08");
    fd.set("qty[line-1]", "1");

    const { lines } = parseDeliveredLines(fd);
    expect(lines).toEqual([{ orderLineId: "line-1", lotNumber: "L26CNT08", actualQty: 1 }]);
  });

  it("keeps a zero quantity, which means nothing was left", () => {
    const fd = new FormData();
    fd.set("qty[line-1]", "0");
    expect(parseDeliveredLines(fd).lines).toEqual([{ orderLineId: "line-1", actualQty: 0 }]);
  });

  it("ignores blanks and non-numbers rather than inventing a value", () => {
    const fd = new FormData();
    fd.set("qty[line-1]", "   ");
    fd.set("lot[line-2]", "");
    fd.set("qty[line-3]", "abc");
    fd.set("empty[prod-1]", "0");
    const { lines, emptiesByProductId } = parseDeliveredLines(fd);
    expect(lines).toEqual([]);
    expect(emptiesByProductId).toEqual({});
  });

  it("reads empties by product and leaves other fields alone", () => {
    const fd = new FormData();
    fd.set("stopId", "stop-1");
    fd.set("notes", "left with the manager");
    fd.set("empty[prod-1]", "3");
    const { lines, emptiesByProductId } = parseDeliveredLines(fd);
    expect(lines).toEqual([]);
    expect(emptiesByProductId).toEqual({ "prod-1": 3 });
  });
});

describe("a BOL number issued outside this system", () => {
  // Unique per run: shipments.bol_number is UNIQUE and this database persists
  // between `vitest` runs, so a fixed string passes once and then never again.
  const extBol = () => `WLA-TEST-${suffix()}`;

  it("survives dispatch instead of being replaced by a minted one", async () => {
    const f = await fixture(1);
    const { order } = f.orders[0];
    await addStopToRoute(f.route.id, order.id);
    const n = extBol();
    await setExternalBolNumber(order.id, n);

    const { bolNumbers } = await dispatchRoute(f.route.id, f.driver.id);

    expect(bolNumbers).toEqual([n]);
    const shipment = await testDb.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    expect(shipment.bolNumber).toBe(n);
    expect(shipment.status).toBe("in_transit");
  });

  it("is the number the delivery is finally recorded under", async () => {
    const f = await fixture(1);
    const { order } = f.orders[0];
    await addStopToRoute(f.route.id, order.id);
    const n = extBol();
    await setExternalBolNumber(order.id, n);
    await dispatchRoute(f.route.id, f.driver.id);

    const result = await markDelivered({
      orderId: order.id,
      deliveredByUserId: f.driver.id,
      actor: "ops",
    });
    expect(result.bolNumber).toBe(n);
  });

  it("records that the number did not come from our counter", async () => {
    const f = await fixture(1);
    const { order } = f.orders[0];
    await addStopToRoute(f.route.id, order.id);
    const n = extBol();
    await setExternalBolNumber(order.id, n, { note: "printed by hand" });

    const ev = await testDb.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, eventType: "bol.issued" },
      orderBy: { createdAt: "desc" },
    });
    const p = ev.payloadJson as { at?: string; bolNumber?: string; note?: string };
    expect(p.at).toBe("external");
    expect(p.bolNumber).toBe(n);
    expect(p.note).toBe("printed by hand");
  });

  it("refuses a number already on another shipment", async () => {
    const f = await fixture(2);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await addStopToRoute(f.route.id, f.orders[1].order.id);
    const n = extBol();
    await setExternalBolNumber(f.orders[0].order.id, n);

    await expect(setExternalBolNumber(f.orders[1].order.id, n)).rejects.toThrow(
      /already on another shipment/i,
    );
  });

  it("refuses to quietly replace a number the order already has", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    const n = extBol();
    await setExternalBolNumber(f.orders[0].order.id, n);

    await expect(setExternalBolNumber(f.orders[0].order.id, extBol())).rejects.toThrow(/already carries/i);
    // Setting the same one again is a no-op, not an error.
    await expect(setExternalBolNumber(f.orders[0].order.id, n)).resolves.toBeUndefined();
  });

  it("refuses once the delivery has happened", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await dispatchRoute(f.route.id, f.driver.id);
    await markDelivered({ orderId: f.orders[0].order.id, deliveredByUserId: f.driver.id, actor: "ops" });

    await expect(setExternalBolNumber(f.orders[0].order.id, extBol())).rejects.toThrow(/already delivered/i);
  });

  it("rejects an empty number", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id, f.orders[0].order.id);
    await expect(setExternalBolNumber(f.orders[0].order.id, "   ")).rejects.toThrow(/required/i);
  });
});

describe("custom delivery stops", () => {
  it("dispatches a custom-only route without creating shipments and settles when completed", async () => {
    const f = await fixture(0);
    const stop = await testDb.routeStop.create({ data: { routeId: f.route.id, sequence: 1, stopName: "Supply pickup", stopAddress: "100 Main St, Los Angeles, CA" } });
    const result = await dispatchRoute(f.route.id, f.driver.id);
    expect(result.stopCount).toBe(1); expect(result.bolNumbers).toEqual([]);
    const { routeManifest, routeTotals, settleRouteStatus } = await import("@/lib/routes");
    const loaded = (await loadRoute(f.route.id))!;
    expect(routeManifest(loaded)).toEqual([]); expect(routeTotals(loaded)).toEqual({stops:1,units:0,kegs:0});
    await testDb.routeStop.update({where:{id:stop.id},data:{status:"delivered",completedAt:new Date()}});
    await settleRouteStatus(f.route.id);
    expect((await loadRoute(f.route.id))!.status).toBe("completed");
  });
  it("keeps custom and order stops in one sequence and only issues order paperwork", async () => {
    const f = await fixture(1);
    await addStopToRoute(f.route.id,f.orders[0].order.id);
    const stop = await testDb.routeStop.create({ data: { routeId:f.route.id,sequence:2,stopName:"Return supplies",stopAddress:"200 Main St, Los Angeles, CA" } });
    await moveStop(stop.id,"up");
    expect((await loadRoute(f.route.id))!.stops[0].id).toBe(stop.id);
    const result = await dispatchRoute(f.route.id,f.driver.id);
    expect(result.stopCount).toBe(2); expect(result.bolNumbers).toHaveLength(1);
    await failStop(stop.id,"Closed");
    expect((await loadRoute(f.route.id))!.stops[0].status).toBe("failed");
  });
  it("rejects stale review signatures inside the dispatch transaction", async () => {
    const f = await fixture(0);
    await testDb.routeStop.create({data:{routeId:f.route.id,sequence:1,stopName:"Pickup",stopAddress:"123 Main St"}});
    await expect(dispatchRoute(f.route.id,f.driver.id,"stale-review")).rejects.toThrow("route changed");
    expect((await loadRoute(f.route.id))!.status).toBe("draft");
  });
});
