/**
 * The marketing request status machine, the request numbering format, and the
 * Slack copy.
 *
 * Tested rather than trusted because all three have a silent failure mode. A
 * transition table that is too permissive lets a stale tab fulfil a request
 * somebody already cancelled — and a fulfilled request is one whose stickers
 * are in the post, so it cannot be walked back. A numbering format that
 * collides puts two requests on one number in a Slack thread nobody can then
 * untangle. And the rush flag is the only thing in the notification that
 * distinguishes "needed in three days" from "needed in three weeks".
 */
import { describe, expect, it } from "vitest";
import {
  canTransition,
  formatRequestNumber,
  repMayCancel,
  transitionsFrom,
  STATUS_LABELS,
} from "@/lib/marketing/requests";
import { buildMarketingMessage } from "@/lib/marketing/slack";
import { categoryRank, isCategory, MARKETING_CATEGORIES } from "@/lib/marketing/catalog";
import type { MarketingRequestStatus } from "@/app/generated/prisma/enums";

const ALL: MarketingRequestStatus[] = ["pending", "approved", "fulfilled", "declined", "cancelled"];

describe("status transitions", () => {
  it("lets marketing work a new request", () => {
    expect(canTransition("pending", "approved")).toBe(true);
    expect(canTransition("pending", "declined")).toBe(true);
    expect(canTransition("pending", "cancelled")).toBe(true);
  });

  it("only fulfils something that was approved", () => {
    expect(canTransition("approved", "fulfilled")).toBe(true);
    // Straight from pending to fulfilled would skip the approval the whole
    // queue exists to record.
    expect(canTransition("pending", "fulfilled")).toBe(false);
    expect(canTransition("declined", "fulfilled")).toBe(false);
    expect(canTransition("cancelled", "fulfilled")).toBe(false);
  });

  it("treats fulfilled as terminal — the stickers are in the post", () => {
    for (const to of ALL) {
      expect(canTransition("fulfilled", to)).toBe(false);
    }
    expect(transitionsFrom("fulfilled")).toHaveLength(0);
  });

  it("reopens a decline and a withdrawal, because both are usually 'not this month'", () => {
    expect(canTransition("declined", "pending")).toBe(true);
    expect(canTransition("declined", "approved")).toBe(true);
    expect(canTransition("cancelled", "pending")).toBe(true);
  });

  it("never offers a transition to itself", () => {
    for (const from of ALL) {
      expect(canTransition(from, from)).toBe(false);
    }
  });

  it("only offers transitions that are real statuses with labels", () => {
    for (const from of ALL) {
      for (const to of transitionsFrom(from)) {
        expect(ALL).toContain(to);
        expect(STATUS_LABELS[to]).toBeTruthy();
      }
    }
  });
});

describe("what a rep may do to his own request", () => {
  it("withdraws one nobody has acted on yet", () => {
    expect(repMayCancel("pending")).toBe(true);
    // Still allowed once approved: marketing has said yes but nothing has
    // shipped, and a rep whose event was called off should not have to phone
    // someone to stop it.
    expect(repMayCancel("approved")).toBe(true);
  });

  it("cannot touch one that is finished either way", () => {
    expect(repMayCancel("fulfilled")).toBe(false);
    expect(repMayCancel("declined")).toBe(false);
    expect(repMayCancel("cancelled")).toBe(false);
  });

  it("never grants a rep more than the transition table does", () => {
    for (const from of ALL) {
      if (repMayCancel(from)) expect(canTransition(from, "cancelled")).toBe(true);
    }
  });
});

describe("request numbers", () => {
  it("is MR-YYMM-NNNN, zero padded so they sort as text", () => {
    expect(formatRequestNumber("2609", 1)).toBe("MR-2609-0001");
    expect(formatRequestNumber("2609", 42)).toBe("MR-2609-0042");
    expect(formatRequestNumber("2612", 1234)).toBe("MR-2612-1234");
  });

  it("does not collide across months at the same sequence", () => {
    expect(formatRequestNumber("2609", 7)).not.toBe(formatRequestNumber("2610", 7));
  });

  it("keeps padding beyond four digits rather than truncating", () => {
    // A month with 10,000 requests is not going to happen, but silently
    // dropping a digit would reuse a number that already exists.
    expect(formatRequestNumber("2609", 12345)).toBe("MR-2609-12345");
  });
});

describe("categories", () => {
  it("accepts the board's ten and nothing else", () => {
    expect(isCategory("Sell Sheets")).toBe(true);
    expect(isCategory("Draft & On-Premise")).toBe(true);
    expect(isCategory("Barware")).toBe(false); // an old tracker group
    expect(isCategory("")).toBe(false);
  });

  it("ranks in the board's own order, not alphabetically", () => {
    expect(categoryRank("Sell Sheets")).toBe(0);
    expect(categoryRank("Sell Sheets")).toBeLessThan(categoryRank("Apparel & Accessories"));
    expect(categoryRank("Other")).toBe(MARKETING_CATEGORIES.length - 1);
  });

  it("sorts an unknown category last rather than first", () => {
    // An item whose category ops typed by hand must not jump the queue ahead
    // of the sell sheets.
    expect(categoryRank("Something New")).toBeGreaterThanOrEqual(MARKETING_CATEGORIES.length);
  });
});

describe("the Slack message", () => {
  const base = {
    requestNumber: "MR-2609-0001",
    repName: "James Williams",
    purpose: "Account Visit",
    shipTo: "Frankie's",
    lines: [{ qty: 2, name: "Cantinesca Coaster", brand: "Cantinesca", unit: "pack of 250", size: null }],
    customRequest: null,
    otherDetails: null,
    attachmentCount: 0,
  };

  /** n whole days from now, at midday, so the floor is unambiguous. */
  const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

  it("leads with the request number and the rep", () => {
    const text = buildMarketingMessage({ ...base, neededBy: inDays(30) });
    expect(text).toContain("MR-2609-0001");
    expect(text).toContain("James Williams");
    expect(text).toContain("Account Visit");
  });

  it("prints the quantity, the item and the unit — 4 of a 250-pack is not 4 coasters", () => {
    const text = buildMarketingMessage({ ...base, neededBy: inDays(30) });
    expect(text).toContain("2× Cantinesca Coaster");
    expect(text).toContain("pack of 250");
  });

  it("does not print a unit for 'each', which would just be noise", () => {
    const text = buildMarketingMessage({
      ...base,
      neededBy: inDays(30),
      lines: [{ qty: 1, name: "Cantinesca Draft Tap Handle", brand: "Cantinesca", unit: "each", size: null }],
    });
    expect(text).toContain("1× Cantinesca Draft Tap Handle");
    expect(text).not.toContain("(each)");
  });

  it("flags anything under a week as a rush", () => {
    const rush = buildMarketingMessage({ ...base, neededBy: inDays(3) });
    expect(rush).toContain("RUSH MARKETING REQUEST");
    expect(rush).toContain("3 days out");

    const calm = buildMarketingMessage({ ...base, neededBy: inDays(21) });
    expect(calm).toContain("MARKETING REQUEST");
    expect(calm).not.toContain("RUSH");
  });

  it("says so when the needed-by date has already passed", () => {
    const text = buildMarketingMessage({ ...base, neededBy: inDays(-2) });
    expect(text).toContain("RUSH");
    expect(text).toContain("date has passed");
  });

  it("carries a custom ask that has no catalogue line behind it", () => {
    const text = buildMarketingMessage({
      ...base,
      neededBy: inDays(30),
      lines: [],
      customRequest: "A 4ft vinyl banner for the Silver Lake launch",
    });
    expect(text).toContain("A 4ft vinyl banner");
    // The "no items" fallback is for a request with neither, which the API
    // refuses — it must not fire on a custom-only request.
    expect(text).not.toContain("No items on this request");
  });

  it("counts attachments so marketing knows to look for artwork", () => {
    const text = buildMarketingMessage({ ...base, neededBy: inDays(30), attachmentCount: 2 });
    expect(text).toContain("2 attachments");
    const one = buildMarketingMessage({ ...base, neededBy: inDays(30), attachmentCount: 1 });
    expect(one).toContain("1 attachment");
    expect(one).not.toContain("1 attachments");
  });
});
