"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { DOCS_ROLES, assertRole } from "@/lib/ops/session";
import { mintDocumentNumber } from "@/lib/bol/sequence";
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
