"use server";

import { revalidatePath } from "next/cache";
import { put } from "@vercel/blob";
import { db } from "@/lib/db";
import { ADMIN_ROLES, LEDGER_ROLES, assertRole } from "@/lib/ops/session";
import { canTransition } from "@/lib/marketing/requests";
import { postMarketingStatus, setMarketingChannel } from "@/lib/marketing/slack";
import { isCategory } from "@/lib/marketing/catalog";
import type { MarketingItemType, MarketingRequestStatus } from "@/app/generated/prisma/enums";

/**
 * The hub's half of the marketing flow: work the queue, and keep the
 * catalogue right.
 *
 * Deciding a request is a LEDGER_ROLES action (admin, ops, warehouse) — the
 * warehouse hand who packs the box is the person who knows it went out, and
 * making him ask an admin to mark it fulfilled would mean it never gets
 * marked. Editing the catalogue is ADMIN_ROLES: a wrong sku or supplier
 * propagates to every future purchase order.
 */

function revalidate(): void {
  revalidatePath("/ops/marketing");
  revalidatePath("/ops/marketing/catalog");
  revalidatePath("/ops");
}

// ---------------------------------------------------------------- requests

/**
 * Move a request. The transition table in lib/marketing/requests.ts is the
 * authority, not the buttons — a stale page open in another tab must not be
 * able to fulfil something that has since been cancelled.
 */
export async function setRequestStatusAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const id = String(formData.get("id"));
  const next = String(formData.get("status")) as MarketingRequestStatus;
  const note = String(formData.get("note") ?? "").trim().slice(0, 2000);

  const existing = await db.marketingRequest.findUnique({
    where: { id },
    select: { id: true, status: true, requestNumber: true, slackChannel: true, slackTs: true },
  });
  if (!existing) throw new Error("No such request.");

  if (!canTransition(existing.status, next)) {
    throw new Error(`A ${existing.status} request cannot become ${next}.`);
  }
  // A decline without a reason is a message the rep cannot act on. Approvals
  // and fulfilments do not need one.
  if (next === "declined" && !note) {
    throw new Error("Say why it is declined — the rep sees this.");
  }

  await db.marketingRequest.update({
    where: { id },
    data: {
      status: next,
      decidedBy: user.name,
      decidedAt: new Date(),
      // Kept rather than overwritten with null: the reason a request was
      // declined is still worth reading after it is reopened and approved.
      ...(note ? { decisionNote: note } : {}),
      events: { create: { action: next, status: next, actor: user.name, note: note || null } },
    },
  });

  // In the request's own Slack thread, so the conversation marketing is
  // already having about it gets the outcome. Never fails the action: the
  // decision is recorded whether or not Slack hears about it.
  try {
    await postMarketingStatus(existing, next, user.name, note || null);
  } catch (error) {
    console.warn("[marketing] Slack status reply failed:", error);
  }

  revalidate();
}

/** Archive or restore. Archiving is not a status — a fulfilled request that
 *  has been filed away is still fulfilled — so it lives in its own column. */
export async function archiveRequestAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const id = String(formData.get("id"));
  const restore = formData.get("restore") === "1";

  await db.marketingRequest.update({
    where: { id },
    data: {
      archivedAt: restore ? null : new Date(),
      events: { create: { action: restore ? "restored" : "archived", actor: user.name } },
    },
  });
  revalidate();
}

/**
 * Delete, softly. The Field Supply Board offers restore on a deleted request
 * and so does this; a row is never actually removed, because the lines on it
 * are the only record of what a supplier was asked to produce.
 */
export async function deleteRequestAction(formData: FormData): Promise<void> {
  const user = await assertRole(ADMIN_ROLES);
  const id = String(formData.get("id"));
  const restore = formData.get("restore") === "1";

  await db.marketingRequest.update({
    where: { id },
    data: {
      deletedAt: restore ? null : new Date(),
      events: { create: { action: restore ? "restored" : "deleted", actor: user.name } },
    },
  });
  revalidate();
}

// --------------------------------------------------------------- catalogue

/** Shared by create and edit. Throws rather than returning errors because the
 *  form posts straight to the action and Next surfaces the throw. */
function readItemForm(formData: FormData) {
  const sku = String(formData.get("sku") ?? "").trim().toUpperCase().slice(0, 60);
  const name = String(formData.get("name") ?? "").trim().slice(0, 200);
  const brand = String(formData.get("brand") ?? "").trim().slice(0, 80);
  const category = String(formData.get("category") ?? "").trim();
  const type = String(formData.get("type") ?? "physical") as MarketingItemType;

  if (!sku) throw new Error("Every item needs a SKU — it is what a purchase order references.");
  if (!name) throw new Error("Every item needs a name.");
  if (!brand) throw new Error("Every item needs a brand.");
  // Validated against the app's list rather than accepted free-form: an item
  // in a category the rep app does not render is an item nobody can order.
  if (!isCategory(category)) throw new Error(`"${category}" is not one of the catalogue's categories.`);
  if (type !== "physical" && type !== "digital") throw new Error("An item is either physical or digital.");

  return {
    sku,
    name,
    brand,
    category,
    type,
    description: String(formData.get("description") ?? "").trim().slice(0, 2000),
    specs: String(formData.get("specs") ?? "").trim().slice(0, 300),
    unit: String(formData.get("unit") ?? "each").trim().slice(0, 60) || "each",
    supplier: String(formData.get("supplier") ?? "").trim().slice(0, 200),
    leadTime: String(formData.get("leadTime") ?? "").trim().slice(0, 200),
    sortOrder: Number(formData.get("sortOrder") ?? 0) || 0,
  };
}

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_IMAGE_BYTES = 4_000_000;

/**
 * Artwork uploaded from the hub goes to Vercel Blob, unlike the seeded items
 * whose images ship in `public/marketing/` (see the seed script for why those
 * are different). `imageUrl` holds either, which is what lets them coexist.
 */
async function uploadImage(file: File | null, sku: string): Promise<string | null> {
  if (!file || file.size === 0) return null;
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${file.type || "That file"} is not a JPEG, PNG or WebP.`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`That image is ${(file.size / 1_000_000).toFixed(1)}MB; the limit is 4MB.`);
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("Image storage is not configured (BLOB_READ_WRITE_TOKEN is unset).");
  }
  const blob = await put(`marketing/catalog/${sku}-${Date.now()}`, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type,
  });
  return blob.url;
}

export async function createItemAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  const fields = readItemForm(formData);

  const existing = await db.marketingItem.findUnique({ where: { sku: fields.sku }, select: { id: true } });
  if (existing) throw new Error(`${fields.sku} already exists. Edit it instead of adding a second one.`);

  const imageUrl = await uploadImage(formData.get("image") as File | null, fields.sku);
  await db.marketingItem.create({ data: { ...fields, imageUrl, active: true } });
  revalidate();
}

export async function updateItemAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  const id = String(formData.get("id"));
  const fields = readItemForm(formData);

  // A sku is what past purchase orders reference, so changing it is allowed
  // but must not collide with another item's.
  const clash = await db.marketingItem.findFirst({
    where: { sku: fields.sku, NOT: { id } },
    select: { id: true },
  });
  if (clash) throw new Error(`${fields.sku} belongs to another item.`);

  const imageUrl = await uploadImage(formData.get("image") as File | null, fields.sku);
  await db.marketingItem.update({
    where: { id },
    // No new file means keep the current image, not clear it — an edit to fix
    // a typo in the specs should not silently strip the artwork.
    data: { ...fields, ...(imageUrl ? { imageUrl } : {}) },
  });
  revalidate();
}

/**
 * Retire or restore. Never a delete: a fulfilled request whose item row
 * vanished is a line nobody can explain at audit, and the line's own copies of
 * the name and sku only cover what it was called at the time.
 */
export async function setItemActiveAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  await db.marketingItem.update({
    where: { id: String(formData.get("id")) },
    data: { active: formData.get("active") === "1" },
  });
  revalidate();
}

// ----------------------------------------------------------------- channel

/** Point marketing requests at a Slack channel without a deploy. */
export async function setMarketingChannelAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  const channelId = String(formData.get("channelId") ?? "").trim();
  if (!channelId) throw new Error("Give a channel id (C…) or a #channel-name.");
  await setMarketingChannel(channelId);
  revalidate();
}
