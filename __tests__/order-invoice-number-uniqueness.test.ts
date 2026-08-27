// Phase 2 (Sheet <-> Postgres sync) fix from adversarial review: the
// sheet-sync webhook's fallback-by-invoiceNumber lookup (used when a Sheet
// row has no Order ID yet) assumed invoice numbers were unique, but nothing
// in the schema actually enforced that -- a real gap, since Code.gs's
// legacy nextInvoiceNumber/nextBolNumber scan-and-increment approach has no
// lock against a race producing a duplicate. Migration
// 20260827233000_line_row_number_and_invoice_unique adds a UNIQUE
// constraint on orders.invoice_number. A plain Postgres UNIQUE constraint
// on a nullable column permits multiple NULLs while enforcing uniqueness
// among non-null values -- exactly what's needed, since most Order rows in
// early testing/draft states won't have an invoice number assigned yet.
import { describe, it, expect, afterAll } from "vitest";
import { testDb, closeTestDb, createFixtureOrder } from "./helpers";
import { ulid } from "ulid";

describe("orders.invoiceNumber uniqueness", () => {
  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects a second order with the same invoice number", async () => {
    const { order, account } = await createFixtureOrder();

    await expect(
      testDb.order.create({
        data: {
          id: ulid(),
          accountId: account.id,
          channel: "rep_app",
          status: "confirmed",
          invoiceNumber: order.invoiceNumber, // duplicate on purpose
        },
      }),
    ).rejects.toThrow();
  });

  it("allows multiple orders with no invoice number at all (NULL != NULL for uniqueness)", async () => {
    const { account } = await createFixtureOrder();

    await expect(
      testDb.order.create({
        data: { id: ulid(), accountId: account.id, channel: "portal", status: "draft", invoiceNumber: null },
      }),
    ).resolves.toBeTruthy();
    await expect(
      testDb.order.create({
        data: { id: ulid(), accountId: account.id, channel: "portal", status: "draft", invoiceNumber: null },
      }),
    ).resolves.toBeTruthy();
  });
});
