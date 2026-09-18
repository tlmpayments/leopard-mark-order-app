import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireDeliveryUser } from "@/lib/ops/session";
import { ACCEPTED_PHOTO_TYPES, MAX_PHOTO_BYTES, savePhoto } from "@/lib/deliveryPhotos";

/**
 * Upload one proof-of-delivery photo.
 *
 * A plain authenticated multipart POST rather than a client-token upload,
 * because the phone downscales before sending (~300KB) and that keeps it well
 * inside the function body limit. One round trip, authorisation on the same
 * request as the bytes, and identical behaviour on localhost and on Vercel --
 * client-token uploads need a publicly reachable completion callback, which
 * localhost does not have.
 */
export async function POST(request: Request): Promise<Response> {
  const user = await requireDeliveryUser();

  const form = await request.formData();
  const stopId = String(form.get("stopId") ?? "");
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No photo in the request." }, { status: 400 });
  }
  if (!ACCEPTED_PHOTO_TYPES.includes(file.type)) {
    return NextResponse.json({ error: `${file.type || "That file"} is not an image.` }, { status: 415 });
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return NextResponse.json({ error: "That photo is too large." }, { status: 413 });
  }

  const stop = await db.routeStop.findUnique({
    where: { id: stopId },
    include: { route: { select: { driverId: true, status: true } } },
  });
  if (!stop) return NextResponse.json({ error: "That stop no longer exists." }, { status: 404 });

  // Same ownership rule as completing the stop: a driver acts on their own
  // route and nobody else's. Ops and admin are unscoped so they can attach a
  // photo a driver texted in.
  if (user.role === "driver" && stop.route.driverId !== user.id) {
    return NextResponse.json({ error: "That route is not assigned to you." }, { status: 403 });
  }
  if (stop.route.status === "draft" || stop.route.status === "cancelled") {
    return NextResponse.json({ error: "That route is not on the road." }, { status: 409 });
  }

  if (!stop.orderId) return NextResponse.json({ error: "Photos are supported on order deliveries only." }, { status: 400 });

  const width = Number.parseInt(String(form.get("width") ?? ""), 10);
  const height = Number.parseInt(String(form.get("height") ?? ""), 10);

  try {
    const photo = await savePhoto({
      orderId: stop.orderId,
      routeStopId: stop.id,
      file,
      contentType: file.type,
      uploadedByUserId: user.id,
      caption: String(form.get("caption") ?? "") || null,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    });
    return NextResponse.json({ id: photo.id, createdAt: photo.createdAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[photos] upload failed:", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
