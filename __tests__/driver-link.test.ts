/**
 * Driver sign-in links.
 *
 * This replaces a typed PIN with a held URL, so the tests that matter are the
 * ones about what the URL is worth: only its hash is stored, a revoked one is
 * dead, and it never resolves to anyone but the one driver it was cut for.
 */
import { afterAll, describe, expect, it } from "vitest";
import { testDb, closeTestDb } from "./helpers";
import {
  hashToken,
  linksForDriver,
  mintDriverLink,
  revokeAllForDriver,
  revokeDriverLink,
  verifyDriverLink,
} from "@/lib/driverLink";

const suffix = () => Math.random().toString(36).slice(2, 10);
const makeDriver = () => testDb.rep.create({ data: { name: `Link Driver ${suffix()}`, role: "driver" } });

afterAll(async () => {
  await closeTestDb();
});

describe("issuing", () => {
  it("stores only the hash, never the token", async () => {
    const d = await makeDriver();
    const { token, id } = await mintDriverLink(d.id);

    const row = await testDb.driverAccessToken.findUniqueOrThrow({ where: { id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toBe(token);
    // The plaintext must not appear anywhere on the row.
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("produces a long, unguessable, URL-safe token", async () => {
    const d = await makeDriver();
    const { token, url } = await mintDriverLink(d.id, { baseUrl: "https://delivery.tlmbg.co" });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(url).toBe(`https://delivery.tlmbg.co/delivery/k/${token}`);
  });

  it("never issues the same token twice", async () => {
    const d = await makeDriver();
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) seen.add((await mintDriverLink(d.id)).token);
    expect(seen.size).toBe(10);
  });

  it("refuses to cut a link for someone who is not a driver", async () => {
    const rep = await testDb.rep.create({ data: { name: `Not A Driver ${suffix()}`, role: "rep" } });
    await expect(mintDriverLink(rep.id)).rejects.toThrow(/drivers only/i);
  });

  it("refuses an inactive driver", async () => {
    const d = await testDb.rep.create({ data: { name: `Gone ${suffix()}`, role: "driver", active: false } });
    await expect(mintDriverLink(d.id)).rejects.toThrow(/not active/i);
  });
});

describe("redeeming", () => {
  it("resolves to the driver it was cut for", async () => {
    const d = await makeDriver();
    const { token } = await mintDriverLink(d.id);

    const who = await verifyDriverLink(token);
    expect(who).toEqual({ id: d.id, name: d.name, role: "driver" });
  });

  it("stamps last used, so a stale link is visible", async () => {
    const d = await makeDriver();
    const { token, id } = await mintDriverLink(d.id);
    expect((await testDb.driverAccessToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).toBeNull();

    await verifyDriverLink(token);
    expect((await testDb.driverAccessToken.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();
  });

  it("rejects a token that was never issued", async () => {
    expect(await verifyDriverLink("k".repeat(43))).toBeNull();
  });

  it("rejects junk without going to the database", async () => {
    for (const junk of ["", "  ", "short", "../../etc/passwd", "a".repeat(500), "has spaces in it"]) {
      expect(await verifyDriverLink(junk)).toBeNull();
    }
  });

  it("rejects a revoked link", async () => {
    const d = await makeDriver();
    const { token, id } = await mintDriverLink(d.id);
    await revokeDriverLink(id);

    expect(await verifyDriverLink(token)).toBeNull();
  });

  it("rejects every link once the driver is deactivated", async () => {
    const d = await makeDriver();
    const { token } = await mintDriverLink(d.id);
    await testDb.rep.update({ where: { id: d.id }, data: { active: false } });

    expect(await verifyDriverLink(token)).toBeNull();
  });

  it("rejects a link whose holder is no longer a driver", async () => {
    const d = await makeDriver();
    const { token } = await mintDriverLink(d.id);
    await testDb.rep.update({ where: { id: d.id }, data: { role: "rep" } });

    expect(await verifyDriverLink(token)).toBeNull();
  });
});

describe("revoking", () => {
  it("kills every live link at once, for a lost phone", async () => {
    const d = await makeDriver();
    const a = await mintDriverLink(d.id, { label: "iPhone" });
    const b = await mintDriverLink(d.id, { label: "spare" });

    expect(await revokeAllForDriver(d.id)).toBe(2);
    expect(await verifyDriverLink(a.token)).toBeNull();
    expect(await verifyDriverLink(b.token)).toBeNull();
  });

  it("keeps the revoked row, so the audit trail still shows it existed", async () => {
    const d = await makeDriver();
    const { id } = await mintDriverLink(d.id, { label: "iPhone" });
    await revokeDriverLink(id);

    const links = await linksForDriver(d.id);
    expect(links).toHaveLength(1);
    expect(links[0].revokedAt).not.toBeNull();
    expect(links[0].label).toBe("iPhone");
  });

  it("does not re-stamp a link that was already revoked", async () => {
    const d = await makeDriver();
    const { id } = await mintDriverLink(d.id);
    await revokeDriverLink(id);
    const first = (await testDb.driverAccessToken.findUniqueOrThrow({ where: { id } })).revokedAt;

    await revokeDriverLink(id);
    const second = (await testDb.driverAccessToken.findUniqueOrThrow({ where: { id } })).revokedAt;
    expect(second).toEqual(first);
  });
});
