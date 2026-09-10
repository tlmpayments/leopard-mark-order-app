"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { DOCS_ROLES, assertRole } from "@/lib/ops/session";
import { mintDocumentNumber } from "@/lib/bol/sequence";
import { buildPaperworkInvoice, type PaperworkInvoiceLine } from "@/lib/billing/paperworkInvoice";
import { resolveUnitPrice } from "@/lib/billing/pricing";
import type { DeliveryReceiptData, DocLine } from "@/lib/bol/render";

/**
 * Generate a paperwork-only document.
 *
 * Writes a DocumentLog row and NOTHING else. No InventoryEvent, no Shipment, no
 * keg custody — that separation is the entire reason this surface exists, and
 * it is what makes it safe to hand to a `docs_only` user.
 */
export async function generatePaperworkAction(formData: FormData): Promise<void> {
  const user = await assertRole(DOCS_ROLES);

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) throw new Error("Pick an account");

  const dateRaw = String(formData.get("date") ?? "");
  const date = dateRaw ? new Date(`${dateRaw}T12:00:00Z`) : new Date();

  const qtyByProduct = new Map<string, number>();
  const lotByProduct = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    const q = /^qty\[(.+)\]$/.exec(key);
    if (q) {
      const n = Number.parseInt(String(value), 10);
      if (Number.isFinite(n) && n > 0) qtyByProduct.set(q[1], n);
    }
    const l = /^lot\[(.+)\]$/.exec(key);
    if (l && String(value).trim()) lotByProduct.set(l[1], String(value).trim());
  }
  if (qtyByProduct.size === 0) throw new Error("Add at least one line with a quantity");

  const [account, products] = await Promise.all([
    db.account.findUniqueOrThrow({ where: { id: accountId } }),
    db.product.findMany({ where: { id: { in: [...qtyByProduct.keys()] } } }),
  ]);

  const lines: DocLine[] = products.map((p) => ({
    sku: p.skuCode,
    description: `${p.productName} ${p.formatDetail}`.trim(),
    package: p.packageType ?? p.formatLabel,
    qty: qtyByProduct.get(p.id) ?? 0,
    lot: lotByProduct.get(p.id) ?? null,
    weightPerUnit: p.weightPerUnit ? Number(p.weightPerUnit) : null,
    isKeg: p.isKeg,
  }));

  const docNumber = await mintDocumentNumber("DR", date);

  const payload: DeliveryReceiptData = {
    docType: "delivery",
    bolNumber: docNumber,
    date: new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date),
    toAccount: {
      BusinessName: account.businessName,
      LegalName: account.legalEntity,
      DeliveryAddress: account.deliveryAddress ?? account.address,
      LicenseNumber: account.licenseNumber,
      PaymentMethod: account.paymentMethod,
      Terms: account.terms,
    },
    deliveryWindow: account.deliveryWindow,
    receivingInstructions: account.deliveryInstructions,
    actor: user.name,
    refNote: String(formData.get("refNote") ?? "") || null,
    notes: String(formData.get("notes") ?? "") || null,
    lines,
  };

  await db.documentLog.create({
    data: {
      docNumber,
      docType: "delivery_receipt",
      date,
      summary: `${account.businessName} · ${lines.reduce((s, l) => s + l.qty, 0)} units`,
      // The full payload is stored verbatim so reopening a document restores
      // it exactly, rather than reconstructing it from current account data
      // that may since have changed.
      payloadJson: JSON.parse(JSON.stringify(payload)),
      createdByUserId: user.id,
    },
  });

  revalidatePath("/docs");
  redirect(`/docs?doc=${encodeURIComponent(docNumber)}`);
}

/**
 * Generate a paperwork-only invoice.
 *
 * Same contract as the delivery receipt above: one DocumentLog row, no Stripe
 * call, no `Invoice` row, no ledger event. An invoice issued to a customer for
 * real is a different act, and it lives on a delivered order in the hub
 * (lib/billing/issue.ts) where it can be reconciled against a payment.
 *
 * What IS shared is every number on it -- `buildPaperworkInvoice` runs the same
 * `composeInvoice` the Stripe path runs -- and every fact: accounts, the
 * product catalogue, per-account pricing and the deposit rates are read here,
 * live, and the browser's copies are never trusted.
 */
export async function generateInvoiceAction(formData: FormData): Promise<void> {
  const user = await assertRole(DOCS_ROLES);

  const accountId = String(formData.get("accountId") ?? "");
  if (!accountId) throw new Error("Pick an account");

  const deliveryRaw = String(formData.get("deliveryDate") ?? "");
  const deliveryDate = deliveryRaw ? new Date(`${deliveryRaw}T12:00:00Z`) : new Date();
  const poRaw = String(formData.get("poDate") ?? "");
  const poDate = poRaw ? new Date(`${poRaw}T12:00:00Z`) : null;

  // One row per line index, so a line the operator deleted simply is not here.
  const submitted = new Map<number, { productId: string; qty: number; unitPrice: string; lot: string }>();
  for (const [key, value] of formData.entries()) {
    const m = /^line\[(\d+)]\[(productId|qty|unitPrice|lot)]$/.exec(key);
    if (!m) continue;
    const idx = Number.parseInt(m[1], 10);
    const row = submitted.get(idx) ?? { productId: "", qty: 0, unitPrice: "", lot: "" };
    if (m[2] === "productId") row.productId = String(value);
    if (m[2] === "qty") row.qty = Number.parseInt(String(value), 10) || 0;
    if (m[2] === "unitPrice") row.unitPrice = String(value);
    if (m[2] === "lot") row.lot = String(value).trim();
    submitted.set(idx, row);
  }

  const rows = [...submitted.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, row]) => row)
    .filter((row) => row.productId && row.qty > 0);
  if (rows.length === 0) throw new Error("Add at least one line with a quantity");

  const [account, products] = await Promise.all([
    db.account.findUniqueOrThrow({
      where: { id: accountId },
      include: {
        salesRep: { select: { name: true } },
        contacts: { orderBy: { createdAt: "asc" }, take: 1 },
        accountPricing: { select: { productId: true, price: true } },
      },
    }),
    db.product.findMany({ where: { id: { in: rows.map((r) => r.productId) } } }),
  ]);

  const byId = new Map(products.map((p) => [p.id, p]));
  const accountPrice = new Map(account.accountPricing.map((p) => [p.productId, Number(p.price)]));

  const lines: PaperworkInvoiceLine[] = rows.map((row) => {
    const product = byId.get(row.productId);
    if (!product) throw new Error("Unknown product on a line");
    // An operator may override the price on the document (a one-off, a
    // correction); with the field left empty the catalogue answers, and the
    // catalogue is what the browser showed them in the first place.
    const typed = row.unitPrice.trim() === "" ? null : Number(row.unitPrice);
    const resolved = resolveUnitPrice(Number(product.listPrice), accountPrice.get(product.id));
    const unitPrice = typed != null && Number.isFinite(typed) && typed >= 0 ? typed : resolved.unitPrice;

    return {
      skuCode: product.skuCode,
      productName: product.productName,
      formatLabel: product.formatDetail || product.formatLabel,
      upc: product.upc,
      isKeg: product.isKeg,
      depositAmount: product.depositAmount ? Number(product.depositAmount) : null,
      qty: row.qty,
      unitPrice,
      lot: row.lot || null,
    };
  });

  // The number is editable, because a document sometimes has to match one
  // already quoted on the phone or written on a sheet. Left alone it is minted
  // from the same per-day counter the delivery receipts use, so two people
  // printing at once cannot land on the same one.
  const typedNumber = String(formData.get("invoiceNumber") ?? "").trim();
  const invoiceNumber = typedNumber || (await mintDocumentNumber("INV", deliveryDate));

  const shipToAddress = account.deliveryAddress ?? account.address;
  const doc = buildPaperworkInvoice({
    invoiceNumber,
    poDate,
    deliveryDate,
    terms: account.terms,
    taxExempt: account.taxExempt,
    salesRep: account.salesRep?.name ?? null,
    shipTo: {
      name: account.businessName,
      address: shipToAddress,
      phone: account.contacts[0]?.phoneE164 ?? null,
      license: account.licenseNumber,
    },
    billTo: {
      name: account.legalEntity || account.businessName,
      address: account.address ?? shipToAddress,
    },
    lines,
    kegReturnQty: Number.parseInt(String(formData.get("kegReturnQty") ?? "0"), 10) || 0,
    notes: String(formData.get("notes") ?? "").trim() || null,
    preparedBy: user.name,
  });

  await db.documentLog.create({
    data: {
      docNumber: invoiceNumber,
      docType: "invoice",
      date: deliveryDate,
      summary: `${account.businessName} · ${MONEY.format(doc.total)}`,
      // Stored verbatim, like the receipts: an invoice is a statement of what
      // was billed on the day, and reprinting it must not pick up a price
      // change or an address change made since.
      payloadJson: JSON.parse(JSON.stringify(doc)),
      createdByUserId: user.id,
    },
  });

  revalidatePath("/docs/invoice");
  redirect(`/docs/invoice?doc=${encodeURIComponent(invoiceNumber)}`);
}

const MONEY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
