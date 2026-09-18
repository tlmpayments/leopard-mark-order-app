/**
 * The Ops Hub's shared PIN.
 *
 * The hub was open to anyone with the hostname until this PIN replaced the
 * OPS_PUBLIC_ACCESS flag, so the tests that matter are the ones about what the
 * four digits are worth: an unset PIN must not be settable by the first
 * visitor to guess (which is what `verifyRepPin`'s first-login branch does for
 * a person, and must never do for a shared account), and a deactivated row
 * must stop opening the door.
 */
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { testDb, closeTestDb } from "./helpers";
import { verifyRepPin } from "@/lib/repAuth";
import { verifyHubPin, HUB_PIN_REP_NAME } from "@/lib/ops/hubPin";

const suffix = () => Math.random().toString(36).slice(2, 10);

/** A shared-style account: a Rep row that is a door, not a person. */
async function makeShared(opts: { pin?: string; active?: boolean } = {}) {
  return testDb.rep.create({
    data: {
      name: `Shared Hub ${suffix()}`,
      role: "admin",
      active: opts.active ?? true,
      pinHash: opts.pin ? await bcrypt.hash(opts.pin, 10) : null,
    },
  });
}

afterAll(async () => {
  await closeTestDb();
});

describe("a shared account's PIN", () => {
  it("opens with the right four digits", async () => {
    const rep = await makeShared({ pin: "4271" });
    const result = await verifyRepPin(rep.name, "4271", undefined, { allowFirstLoginSet: false });
    expect(result.ok).toBe(true);
    expect(result.rep?.id).toBe(rep.id);
  });

  it("refuses the wrong four digits", async () => {
    const rep = await makeShared({ pin: "4271" });
    const result = await verifyRepPin(rep.name, "4272", undefined, { allowFirstLoginSet: false });
    expect(result.ok).toBe(false);
  });

  it("cannot be defined by whoever knocks first", async () => {
    const rep = await makeShared();
    const result = await verifyRepPin(rep.name, "0000", undefined, { allowFirstLoginSet: false });

    expect(result.ok).toBe(false);
    // The point of the option: no PIN was written as a side effect of the
    // attempt, so the account stays shut rather than becoming the guesser's.
    const after = await testDb.rep.findUniqueOrThrow({ where: { id: rep.id } });
    expect(after.pinHash).toBeNull();
  });

  it("still lets a person set their own PIN on first sign-in", async () => {
    // The same call without the option -- the rep-app and driver flows depend
    // on this, so the shared-account rule must not have changed it.
    const rep = await makeShared();
    const result = await verifyRepPin(rep.name, "0000");

    expect(result.ok).toBe(true);
    const after = await testDb.rep.findUniqueOrThrow({ where: { id: rep.id } });
    expect(after.pinHash).not.toBeNull();
  });

  it("stops opening once the row is deactivated", async () => {
    const rep = await makeShared({ pin: "4271", active: false });
    const result = await verifyRepPin(rep.name, "4271", undefined, { allowFirstLoginSet: false });
    expect(result.ok).toBe(false);
  });
});

describe("verifyHubPin", () => {
  it("signs in as the shared hub row and nothing else", async () => {
    expect(HUB_PIN_REP_NAME).toBe("Ops Hub");
  });

  it("refuses anything that is not four digits", async () => {
    // Read-only on purpose: the real "Ops Hub" row's PIN is live, so these
    // assertions must not be able to write to it.
    expect(await verifyHubPin("")).toBeNull();
    expect(await verifyHubPin("888")).toBeNull();
    expect(await verifyHubPin("88888")).toBeNull();
    expect(await verifyHubPin("abcd")).toBeNull();
  });
});
