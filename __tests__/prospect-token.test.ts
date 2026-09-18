import { describe, it, expect, beforeAll } from "vitest";

// The signing key is derived from AUTH_SECRET, which a test run has no reason
// to carry. Set it here so the suite passes on a bare checkout rather than
// only when someone remembers to prefix the command.
beforeAll(() => {
  process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-for-prospect-tokens";
});
import { issueRepToken, verifyRepToken } from "@/lib/prospects/repToken";

describe("rep token", () => {
  it("round-trips an identity", () => {
    const token = issueRepToken({ rep: "James Williams", role: "Rep" });
    expect(verifyRepToken(token)).toEqual({ rep: "James Williams", role: "Rep" });
  });
  it("refuses a token whose rep name was edited", () => {
    const token = issueRepToken({ rep: "James Williams", role: "Rep" });
    const forged = token.replace("James%20Williams", "Ricardo%20Villanueva");
    expect(verifyRepToken(forged)).toBeNull();
  });
  it("refuses a token whose role was escalated", () => {
    const token = issueRepToken({ rep: "James Williams", role: "Rep" });
    expect(verifyRepToken(token.replace(".Rep.", ".Admin."))).toBeNull();
  });
  it("refuses an expired token", () => {
    const token = issueRepToken({ rep: "James Williams", role: "Rep" }, Date.now() - 1000 * 60 * 60 * 24 * 40);
    expect(verifyRepToken(token)).toBeNull();
  });
  it("refuses junk", () => {
    expect(verifyRepToken("")).toBeNull();
    expect(verifyRepToken("nonsense")).toBeNull();
    expect(verifyRepToken("a.b.c.d")).toBeNull();
  });
});
