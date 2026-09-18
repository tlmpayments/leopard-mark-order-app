import { NextResponse } from "next/server";
import { issueRepToken, verifyPinWithAppsScript } from "@/lib/prospects/repToken";

/**
 * Trade a rep's PIN for a token the prospect API will accept.
 *
 * The rep app calls this once, on login. Everything after that carries the
 * token instead, so the PIN is typed on the login screen and nowhere else.
 */
export async function POST(request: Request): Promise<Response> {
  let pin = "";
  try {
    const body = (await request.json()) as { pin?: unknown };
    pin = String(body?.pin ?? "").trim();
  } catch {
    return NextResponse.json({ ok: false, error: "Send a JSON body with a pin." }, { status: 400 });
  }

  let identity;
  try {
    identity = await verifyPinWithAppsScript(pin);
  } catch (error) {
    // A misconfigured server is not the rep's fault and must not read like a
    // wrong PIN, or he will sit there retyping a PIN that is perfectly good.
    console.error("[prospects] PIN check failed", error);
    return NextResponse.json({ ok: false, error: "Sign-in is unavailable right now." }, { status: 503 });
  }

  if (!identity) return NextResponse.json({ ok: false, error: "That PIN was not recognised." }, { status: 401 });

  return NextResponse.json({
    ok: true,
    token: issueRepToken(identity),
    rep: identity.rep,
    role: identity.role,
  });
}
