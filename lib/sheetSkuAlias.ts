/**
 * Historical product codes -> today's `Product.skuCode`.
 *
 * Lives in lib/ rather than inside the import script because it is domain
 * knowledge about the Sales tab, not script plumbing: the nightly reconcile and
 * any future Sheet->DB path need the same translation, and a test of it should
 * not have to import a script whose module scope runs an import.
 *
 * The Sales tab spans several generations of product coding, and only recent
 * rows use today's scheme. Two older families account for nearly all of it:
 *
 *   TLM-SGB1AKHB01-M        a current SKU wrapped in a prefix and a suffix
 *   TLM-SGB1AC1224-6PK      ditto, where the suffix is a pack variant
 *   TLM.PRO.CNT-KEG.1/2     facility . brand - package . size
 *   TLM.EBB.SGB-CAN.12oz    ditto (EBB East Brother, PRO Prost, BCH Beachwood)
 *
 * The second family decodes cleanly because every brand shares three format
 * codes: `<BRAND>1AKHB01` for a 1/2 bbl keg, `<BRAND>1AKSB01` for a 1/6, and
 * `<BRAND>1AC1224` for a 12oz x24 case. The contract-brewing facility in the
 * middle is not part of a SKU today -- the same beer brewed at two facilities
 * is one SKU -- so it is dropped.
 */

/** 1/2 bbl keg, 1/6 bbl keg, and 12oz x24 case, for any brand. */
const FORMAT_SUFFIX = {
  keg_half: "1AKHB01",
  keg_sixth: "1AKSB01",
  case_12oz: "1AC1224",
} as const;

/** The brands whose codes decode unambiguously. */
const KNOWN_BRANDS = /^(CNT|SGB|SGS|GSP)$/;

/**
 * Translate a Sales-tab product code, or return null when there is no
 * confident mapping.
 *
 * Null is a deliberate outcome, not a failure: an "Experimental Hazy I" row
 * could be XHZ variant B, C or D, and choosing one would be a guess dressed up
 * as data. The caller reports those lines instead of importing them.
 *
 * A `-6PK` row maps to the 24-case SKU, which is coarser than the original
 * code. That distorts no money -- line quantities and unit prices are taken
 * from the invoice itself, so only the SKU attribution is approximate -- and
 * the alternative is dropping the order entirely.
 */
export function aliasHistoricalSku(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  if (!code) return null;

  // Family 1: TLM-<SKU>-<suffix>
  const wrapped = /^TLM-([A-Z]{3}\d[A-Z]{1,2}\d*[A-Z0-9]*)(?:-|$)/.exec(code);
  if (wrapped) return wrapped[1];

  // Family 2: TLM.<FACILITY>.<BRAND>-<TYPE>.<SIZE>
  const dotted = /^TLM\.[A-Z]+\.(.+?)-(KEG|CAN)\.(.+)$/.exec(code);
  if (dotted) {
    const [, brandRaw, type, sizeRaw] = dotted;
    const brand = brandRaw.trim();
    if (!KNOWN_BRANDS.test(brand)) return null;
    const size = sizeRaw.trim();
    if (type === "KEG" && size === "1/2") return `${brand}${FORMAT_SUFFIX.keg_half}`;
    if (type === "KEG" && size === "1/6") return `${brand}${FORMAT_SUFFIX.keg_sixth}`;
    if (type === "CAN" && /^12\s*OZ$/.test(size)) return `${brand}${FORMAT_SUFFIX.case_12oz}`;
    return null;
  }

  return code;
}
