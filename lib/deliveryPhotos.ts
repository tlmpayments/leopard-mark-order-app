/**
 * Proof-of-delivery photos.
 *
 * The bytes go to a PRIVATE Vercel Blob store, which is the whole reason this
 * module exists rather than the pages calling `put` directly: a private blob's
 * URL is not fetchable on its own, so every read has to be presigned by
 * somebody who has already checked who is asking. Keeping the put, the presign
 * and the delete together makes it hard to add a fourth path that forgets.
 *
 * Photos are downscaled on the phone before they get here (see
 * app/delivery/_components/PhotoCapture.tsx). That is not only a bandwidth
 * kindness to a driver on a loading dock: it is what keeps an upload inside the
 * request-body limit of a serverless function, which is what lets this be a
 * plain authenticated POST instead of a client-token dance.
 */

import { del, issueSignedToken, presignUrl, put } from "@vercel/blob";
import { db } from "@/lib/db";

/** Refused above this, after the phone-side downscale. A 1600px JPEG is ~400KB. */
export const MAX_PHOTO_BYTES = 4_000_000;

export const ACCEPTED_PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];

/** How long a presigned read URL lives. Long enough to render a page, not to share. */
const READ_TTL_MS = 5 * 60_000;

export interface SavePhotoInput {
  orderId: string;
  routeStopId?: string | null;
  file: File | Blob;
  contentType: string;
  uploadedByUserId: string;
  caption?: string | null;
  width?: number | null;
  height?: number | null;
}

export function isBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

export async function savePhoto(input: SavePhotoInput) {
  if (!ACCEPTED_PHOTO_TYPES.includes(input.contentType)) {
    throw new Error(`${input.contentType} is not an image we accept.`);
  }
  const size = input.file.size;
  if (size <= 0) throw new Error("That photo came through empty.");
  if (size > MAX_PHOTO_BYTES) {
    throw new Error(`That photo is ${(size / 1_000_000).toFixed(1)}MB; the limit is 4MB.`);
  }
  if (!isBlobConfigured()) {
    throw new Error("Photo storage is not configured (BLOB_READ_WRITE_TOKEN is unset).");
  }

  // Foldered by order so the store stays browsable, and random-suffixed so two
  // photos taken in the same second at the same stop cannot collide.
  const ext = extensionFor(input.contentType);
  const blob = await put(`delivery/${input.orderId}/${Date.now()}.${ext}`, input.file, {
    access: "private",
    addRandomSuffix: true,
    contentType: input.contentType,
  });

  return db.deliveryPhoto.create({
    data: {
      orderId: input.orderId,
      routeStopId: input.routeStopId ?? null,
      pathname: blob.pathname,
      url: blob.url,
      contentType: input.contentType,
      sizeBytes: size,
      width: input.width ?? null,
      height: input.height ?? null,
      caption: input.caption?.trim() || null,
      uploadedByUserId: input.uploadedByUserId,
    },
  });
}

/**
 * A short-lived URL that will actually render the image.
 *
 * Never store or log the result: it is a bearer token for that photo until it
 * expires. Callers hand it straight to an <img src> and let it die.
 */
export async function readUrlFor(pathname: string): Promise<string> {
  const validUntil = Date.now() + READ_TTL_MS;
  // Scoped to this one pathname and to `get` only, so even the delegation this
  // is derived from cannot be turned into a key for the rest of the store.
  const signedToken = await issueSignedToken({
    pathname,
    operations: ["get"],
    validUntil,
  });
  const { presignedUrl } = await presignUrl(signedToken, {
    operation: "get",
    access: "private",
    pathname,
    validUntil,
  });
  return presignedUrl;
}

export async function photosForOrder(orderId: string) {
  return db.deliveryPhoto.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
}

export async function photosForStop(routeStopId: string) {
  return db.deliveryPhoto.findMany({ where: { routeStopId }, orderBy: { createdAt: "asc" } });
}

/** Photo counts for a set of orders, for list screens that must not N+1. */
export async function photoCountsByOrder(orderIds: string[]): Promise<Map<string, number>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db.deliveryPhoto.groupBy({
    by: ["orderId"],
    where: { orderId: { in: orderIds } },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.orderId, r._count._all]));
}

/**
 * Remove a mis-taken photo.
 *
 * Only before the stop is delivered. Once the delivery is marked the photos are
 * the evidence that it happened, and evidence that the person being evidenced
 * can delete afterwards is not evidence. A genuinely wrong photo after the fact
 * is an ops problem, not a driver one.
 */
export async function deletePhoto(photoId: string, byUserId: string, isOps: boolean): Promise<void> {
  const photo = await db.deliveryPhoto.findUniqueOrThrow({
    where: { id: photoId },
    include: { order: { select: { deliveredAt: true } } },
  });
  if (!isOps) {
    if (photo.uploadedByUserId !== byUserId) throw new Error("That photo is not yours to remove.");
    if (photo.order.deliveredAt) throw new Error("This stop is delivered; its photos are the record of it.");
  }
  await db.deliveryPhoto.delete({ where: { id: photoId } });
  // After the row, so a blob delete that fails cannot leave a row pointing at
  // bytes that are gone. An orphaned blob is harmless; an orphaned row is a
  // broken image in the evidence trail.
  try {
    await del(photo.url);
  } catch (err) {
    console.warn("[photos] blob delete failed, row already removed:", err);
  }
}

function extensionFor(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/heic") return "heic";
  return "jpg";
}
