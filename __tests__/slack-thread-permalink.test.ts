/**
 * apps-script/Code.gs's slackThreadPermalink -- the link the rep app hands a
 * rep when they tap "Slack thread" on a past order.
 *
 * Worth its own test because every failure mode here is silent: a permalink
 * with the wrong ts encoding, or without thread_ts/cid, still LOOKS like a
 * valid Slack URL and still opens Slack. It just doesn't land on the thread,
 * and nothing anywhere reports that it didn't.
 *
 * Code.gs is a Google Apps Script file with no module system, so the
 * function is extracted from the source and evaluated rather than imported.
 * That's deliberate: it keeps the assertion against the code that actually
 * ships to Apps Script, instead of a copy in lib/ that could drift from it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function loadFromCodeGs<T>(functionName: string): T {
  const source = readFileSync(join(__dirname, "..", "apps-script", "Code.gs"), "utf8");
  const start = source.indexOf(`function ${functionName}(`);
  if (start === -1) throw new Error(`${functionName} not found in Code.gs`);
  // Functions in Code.gs are top-level, so the first line that is exactly "}"
  // at column 0 closes the one we're reading.
  const end = source.indexOf("\n}\n", start);
  if (end === -1) throw new Error(`could not find the end of ${functionName}`);
  const body = source.slice(start, end + 3);
  return new Function(`${body}; return ${functionName};`)() as T;
}

const slackThreadPermalink = loadFromCodeGs<
  (domain: string, channel: string, ts: string) => string
>("slackThreadPermalink");

const DOMAIN = "theleopardmark";
const CHANNEL = "C09ABCDEF";
const TS = "1756400000.123456";

describe("slackThreadPermalink", () => {
  it("drops the dot from the ts in the /archives path segment", () => {
    // Slack's own permalink form is p<ts with no dot>. A dot left in gives a
    // 404-ish "message not found" rather than the thread.
    expect(slackThreadPermalink(DOMAIN, CHANNEL, TS)).toContain(
      `/archives/${CHANNEL}/p1756400000123456`,
    );
  });

  it("keeps the ts INTACT (dot and all six microsecond digits) in thread_ts", () => {
    // This is the half that actually selects the thread, and it wants the
    // original dotted form -- the two halves are not interchangeable.
    const url = new URL(slackThreadPermalink(DOMAIN, CHANNEL, TS));
    expect(url.searchParams.get("thread_ts")).toBe(TS);
  });

  it("carries cid so Slack opens the thread panel rather than scrolling the channel", () => {
    const url = new URL(slackThreadPermalink(DOMAIN, CHANNEL, TS));
    expect(url.searchParams.get("cid")).toBe(CHANNEL);
  });

  it("builds the workspace host from the domain alone", () => {
    const url = new URL(slackThreadPermalink(DOMAIN, CHANNEL, TS));
    expect(url.host).toBe("theleopardmark.slack.com");
    expect(url.protocol).toBe("https:");
  });

  it("returns '' when any of the three parts is missing", () => {
    // Every caller treats '' as "this order has no thread link" and hides the
    // button. A half-built URL would render a button that goes nowhere.
    expect(slackThreadPermalink("", CHANNEL, TS)).toBe("");
    expect(slackThreadPermalink(DOMAIN, "", TS)).toBe("");
    expect(slackThreadPermalink(DOMAIN, CHANNEL, "")).toBe("");
  });

  it("does not lose precision on a ts whose suffix ends in zeros", () => {
    // "…100000" is the case a numeric round-trip mangles worst: as a JS/Sheets
    // number the trailing zeros vanish, and 1756400000.1 is a different
    // message than 1756400000.100000. Guards the string handling here; the
    // Sheet side is guarded by stampSlackThreadRef's setNumberFormat('@').
    const url = new URL(slackThreadPermalink(DOMAIN, CHANNEL, "1756400000.100000"));
    expect(url.searchParams.get("thread_ts")).toBe("1756400000.100000");
    expect(url.pathname).toContain("p1756400000100000");
  });
});
