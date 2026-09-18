import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { currentOpsUser, HUB_ROLES, requireDeliveryUser } from "@/lib/ops/session";
import { deletePhoto, readUrlFor } from "@/lib/deliveryPhotos";

/**
 * Serve one proof-of-delivery photo.
 *
 * Redirects to a short-lived presigned URL rather than streaming the bytes: the
 * CDN does the transfer, and the authorisation still happens here, on every
 * single view, because the presigned URL expires in minutes and is never
 * persisted anywhere.
 *
 * Readable by anyone who can open the hub, plus the driver whose route it is.
 * Not public -- these are photographs inside a customer's premises.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const user = await currentOpsUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const photo = await db.deliveryPhoto.findUnique({
    where: { id },
    include: { routeStop: { select: { route: { select: { driverId: true } } } } },
  });
  if (!photo) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isHub = HUB_ROLES.includes(user.role);
  const isTheirRoute = photo.routeStop?.route.driverId === user.id;
  if (!isHub && !isTheirRoute) {
    return NextResponse.json({ error: "Not yours to view" }, { status: 403 });
  }

  const url = await readUrlFor(photo.pathname);
  return NextResponse.redirect(url, {
    // Never cached by a shared cache: the redirect target is a bearer URL.
    headers: { "cache-control": "private, no-store" },
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const user = await requireDeliveryUser();
  try {
    await deletePhoto(id, user.id, HUB_ROLES.includes(user.role));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Delete failed" }, { status: 400 });
  }
}
