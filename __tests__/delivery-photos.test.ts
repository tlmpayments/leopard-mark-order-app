/**
 * Proof-of-delivery photos.
 *
 * The blob store itself is not exercised here — `savePhoto` reaches Vercel Blob
 * and a test that needs network is a test nobody runs. What IS tested is
 * everything around it that decides who may see and remove evidence, plus the
 * rule that keeps a photo attached to the delivery when the plan around it is
 * rebuilt. Those are the parts that would quietly go wrong.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@/app/generated/prisma/client";
import { testDb, closeTestDb } from "./helpers";
import { addStopToRoute, createRoute, dispatchRoute, removeStopFromRoute, todayYmd } from "@/lib/routes";
import { deletePhoto, photoCountsByOrder, photosForOrder, photosForStop } from "@/lib/deliveryPhotos";
import { markDelivered } from "@/lib/delivery";

const suffix = () => Math.random().toString(36).slice(2, 10);

async function fixture() {
  const s = suffix();
  const warehouse = await testDb.location.create({
    data: { id: `WH-P${s.slice(0, 5)}`, name: `Photo WH ${s}`, type: "warehouse", city: "SF", state: "CA" },
  });
  const driver = await testDb.rep.create({ data: { name: `Photo Driver ${s}`, role: "driver" } });
  const product = await testDb.product.create({
    data: {
      skuCode: `PSKU-${s}`,
      productName: "Cantinesca",
      formatLabel: "1/2 Barrel Keg",
      formatDetail: "15.5 gal",
      unit: "keg",
      isKeg: true,
      listPrice: new Prisma.Decimal(192),
    },
  });
  const account = await testDb.account.create({
    data: { businessName: `Photo Bar ${s}`, region: "San Francisco", deliveryAddress: "1 Test St" },
  });
  const order = await testDb.order.create({
    data: {
      id: `PORD-${s}`,
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
  const route = await createRoute({
    ymd: todayYmd(),
    region: "BA",
    warehouseId: warehouse.id,
    driverId: driver.id,
  });
  await addStopToRoute(route.id, order.id);
  const stop = await testDb.routeStop.findFirstOrThrow({ where: { routeId: route.id } });
  return { route, stop, order, driver, account, s };
}

/** A photo row without touching the blob store. */
async function fakePhoto(orderId: string, routeStopId: string | null, uploadedByUserId: string) {
  const key = `delivery/${orderId}/${suffix()}.jpg`;
  return testDb.deliveryPhoto.create({
    data: {
      orderId,
      routeStopId,
      pathname: key,
      url: `https://example.invalid/${key}`,
      contentType: "image/jpeg",
      sizeBytes: 312_004,
      width: 1600,
      height: 1200,
      uploadedByUserId,
    },
  });
}

afterAll(async () => {
  await closeTestDb();
});

describe("photos belong to the delivery, not the plan", () => {
  it("survives the stop being taken off the route", async () => {
    const f = await fixture();
    await fakePhoto(f.order.id, f.stop.id, f.driver.id);

    await removeStopFromRoute(f.stop.id);

    // The stop is gone; the evidence is not.
    expect(await testDb.routeStop.findUnique({ where: { id: f.stop.id } })).toBeNull();
    const kept = await photosForOrder(f.order.id);
    expect(kept).toHaveLength(1);
    expect(kept[0].routeStopId).toBeNull();
  });

  it("survives the whole route being deleted", async () => {
    const f = await fixture();
    await fakePhoto(f.order.id, f.stop.id, f.driver.id);

    // routeStops cascade from the route; delivery_photos must not.
    await testDb.deliveryRoute.delete({ where: { id: f.route.id } });

    expect(await photosForOrder(f.order.id)).toHaveLength(1);
  });

  it("finds a stop's photos while the stop still exists", async () => {
    const f = await fixture();
    await fakePhoto(f.order.id, f.stop.id, f.driver.id);
    await fakePhoto(f.order.id, f.stop.id, f.driver.id);
    expect(await photosForStop(f.stop.id)).toHaveLength(2);
  });

  it("counts per order in one query, for list screens", async () => {
    const a = await fixture();
    const b = await fixture();
    await fakePhoto(a.order.id, a.stop.id, a.driver.id);
    await fakePhoto(a.order.id, a.stop.id, a.driver.id);
    await fakePhoto(b.order.id, b.stop.id, b.driver.id);

    const counts = await photoCountsByOrder([a.order.id, b.order.id]);
    expect(counts.get(a.order.id)).toBe(2);
    expect(counts.get(b.order.id)).toBe(1);
  });

  it("returns an empty map rather than querying for no orders", async () => {
    expect((await photoCountsByOrder([])).size).toBe(0);
  });
});

describe("who may remove a photo", () => {
  it("lets the driver drop a mis-taken shot before the stop is delivered", async () => {
    const f = await fixture();
    const photo = await fakePhoto(f.order.id, f.stop.id, f.driver.id);

    await deletePhoto(photo.id, f.driver.id, false);

    expect(await testDb.deliveryPhoto.findUnique({ where: { id: photo.id } })).toBeNull();
  });

  it("refuses once the delivery is marked — evidence the subject can delete is not evidence", async () => {
    const f = await fixture();
    await dispatchRoute(f.route.id, f.driver.id);
    const photo = await fakePhoto(f.order.id, f.stop.id, f.driver.id);
    await markDelivered({ orderId: f.order.id, deliveredByUserId: f.driver.id, actor: "ops" });

    await expect(deletePhoto(photo.id, f.driver.id, false)).rejects.toThrow(/delivered/i);
    expect(await testDb.deliveryPhoto.findUnique({ where: { id: photo.id } })).not.toBeNull();
  });

  it("refuses another driver's photo outright", async () => {
    const f = await fixture();
    const photo = await fakePhoto(f.order.id, f.stop.id, f.driver.id);

    await expect(deletePhoto(photo.id, "some-other-driver", false)).rejects.toThrow(/not yours/i);
  });

  it("lets ops remove one after delivery, because someone has to be able to", async () => {
    const f = await fixture();
    await dispatchRoute(f.route.id, f.driver.id);
    const photo = await fakePhoto(f.order.id, f.stop.id, f.driver.id);
    await markDelivered({ orderId: f.order.id, deliveredByUserId: f.driver.id, actor: "ops" });

    await deletePhoto(photo.id, "an-ops-user", true);
    expect(await testDb.deliveryPhoto.findUnique({ where: { id: photo.id } })).toBeNull();
  });
});
