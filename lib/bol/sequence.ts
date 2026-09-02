/**
 * Real, sequential BOL numbers.
 *
 * The Inventory app derives the next number by scanning the BOLs tab for the
 * highest matching prefix and adding one, with no lock. Two warehouse staff
 * marking deliveries in the same second both read the same maximum and mint the
 * same number -- a duplicate bill of lading, which is a records problem, not
 * just a UI glitch. The BOL Maker has the opposite problem: it mints
 * `DR-<yymmdd>-####` with four random digits and never checks for collisions,
 * because it has no write access to the ledger at all.
 *
 * This replaces both with one counter row taken under `FOR UPDATE`, so N
 * parallel mints produce N distinct numbers. Format is kept byte-compatible
 * with what is already in the BOLs tab: `BOL-<LocationID>-<yymmdd>-<seq>`.
 */

import { Prisma } from "@/app/generated/prisma/client";
import { db } from "@/lib/db";

/** `yymmdd` in America/Los_Angeles -- the timezone the Apps Script runs in, so
 * a delivery marked at 5pm PT lands on the same calendar day it did before. */
export function pacificYymmdd(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}${get("month")}${get("day")}`;
}

/**
 * The legacy format pads to two digits (`-01`), which silently breaks ordering
 * at 100 documents from one location in one day. Padding to a minimum of two
 * keeps every existing number byte-identical while letting the 100th and
 * beyond simply be three digits.
 */
export function formatBolNumber(locationId: string, yymmdd: string, seq: number): string {
  return `BOL-${locationId}-${yymmdd}-${String(seq).padStart(2, "0")}`;
}

/**
 * Mint the next BOL number for a location on a given day.
 *
 * Must be called inside a transaction that also writes whatever the number is
 * for (the shipment, the ledger events), so a crash between minting and using
 * cannot leave a gap. Pass the transaction client in.
 */
export async function mintBolNumber(
  tx: Prisma.TransactionClient,
  locationId: string,
  at: Date = new Date(),
): Promise<string> {
  const yymmdd = pacificYymmdd(at);

  // Upsert-then-lock in one statement: ON CONFLICT DO UPDATE takes a row lock
  // on the existing row, so concurrent callers serialise here and each sees a
  // distinct incremented value. RETURNING gives us that value without a
  // second read that could observe someone else's increment.
  const rows = await tx.$queryRaw<Array<{ last: number }>>`
    INSERT INTO "bol_sequences" ("location_id", "yymmdd", "last")
    VALUES (${locationId}, ${yymmdd}, 1)
    ON CONFLICT ("location_id", "yymmdd")
    DO UPDATE SET "last" = "bol_sequences"."last" + 1
    RETURNING "last"
  `;

  const seq = rows[0]?.last;
  if (typeof seq !== "number") {
    throw new Error(`BOL sequence mint failed for ${locationId} ${yymmdd}`);
  }
  return formatBolNumber(locationId, yymmdd, seq);
}

/**
 * Paperwork-only document numbers for the BOL Maker (§8.7 "Paperwork only").
 *
 * These stay a separate series on purpose: they are for printing a receipt for
 * something that is not a tracked shipment, and giving them real BOL numbers
 * would put gaps and phantom entries in the sequence that the ledger depends
 * on. Unlike the current random-digit scheme they are sequential and unique,
 * counted per day against the `DOC` pseudo-location.
 */
export async function mintDocumentNumber(
  prefix: "DR" | "BOL",
  at: Date = new Date(),
  /**
   * Accepts a client for the same reason `mintBolNumber` requires one: a caller
   * that is already inside a transaction should mint on that connection rather
   * than reaching for a second one out of the pool.
   */
  client: Pick<typeof db, "$queryRaw"> = db,
): Promise<string> {
  const yymmdd = pacificYymmdd(at);
  const pseudoLocation = `DOC-${prefix}`;
  const rows = await client.$queryRaw<Array<{ last: number }>>`
    INSERT INTO "bol_sequences" ("location_id", "yymmdd", "last")
    VALUES (${pseudoLocation}, ${yymmdd}, 1)
    ON CONFLICT ("location_id", "yymmdd")
    DO UPDATE SET "last" = "bol_sequences"."last" + 1
    RETURNING "last"
  `;
  const seq = rows[0]?.last ?? 1;
  return `${prefix}-${yymmdd}-${String(seq).padStart(4, "0")}`;
}
