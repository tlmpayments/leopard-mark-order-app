/**
 * Matching a Sheet "Customer" string to an `Account`.
 *
 * The Sales tab writes the customer as `<legal entity> / <DBA>` —
 * "Sutro Syndicate LLC / 540 SF", "Andre Boudin Bakeries Inc. / Boudin Bakery
 * (Downstairs)" — and those two halves live in two different columns on the
 * account: `legalEntity` and `businessName`. The combined string exists in
 * neither, so normalising the whole thing and looking it up matches *nothing*.
 * That is not a hypothetical: it skipped all 284 orders on the first import run.
 *
 * Sometimes the DBA half is blank ("El Canton De La Patrona / "), and the
 * Customer Accounts tab writes the establishment name on its own with no slash
 * at all, so both shapes have to work.
 *
 * Shared by the order importer and the account importer so the two cannot drift
 * into disagreeing about which account a row belongs to.
 */

/** Strip corporate suffixes and punctuation so spelling variants collapse. */
export function normalizeAccountName(v: string): string {
  return v
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|co|corp|company|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/**
 * The names worth trying, most specific first: the whole string, then the DBA
 * half (which is what `businessName` usually holds), then the legal half.
 */
export function candidateNames(sheetCustomer: string): string[] {
  const whole = (sheetCustomer ?? "").trim();
  const parts = whole
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set([whole, ...parts.slice().reverse(), ...parts].filter(Boolean))];
}

export interface MatchableAccount {
  id: string;
  businessName: string;
  legalEntity?: string | null;
}

/**
 * Build a resolver over a set of accounts.
 *
 * Two indexes are kept apart so a DBA can never accidentally win against
 * another account's legal entity when a more specific match was available.
 */
export function buildAccountResolver<T extends MatchableAccount>(
  accounts: readonly T[],
): (sheetCustomer: string) => T | undefined {
  const byBusinessName = new Map<string, T>();
  const byLegalEntity = new Map<string, T>();
  for (const a of accounts) {
    const bn = normalizeAccountName(a.businessName);
    if (bn && !byBusinessName.has(bn)) byBusinessName.set(bn, a);
    if (a.legalEntity) {
      const le = normalizeAccountName(a.legalEntity);
      if (le && !byLegalEntity.has(le)) byLegalEntity.set(le, a);
    }
  }

  return (sheetCustomer: string): T | undefined => {
    for (const name of candidateNames(sheetCustomer)) {
      const norm = normalizeAccountName(name);
      if (!norm) continue;
      const hit = byBusinessName.get(norm) ?? byLegalEntity.get(norm);
      if (hit) return hit;
    }
    return undefined;
  };
}
