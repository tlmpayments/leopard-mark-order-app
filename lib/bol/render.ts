/**
 * The one document renderer (§8.7, §13 "one renderer, no more manual copy").
 *
 * Until now this logic existed twice: `assets/js/bol.js` in the Inventory app
 * and a hand-synced copy in the BOL Maker. They had already drifted — the BOL
 * Maker's copy gained SKU and LOT # columns, a package-type line break, a
 * single party block for manual addresses, and the @page print rules that make
 * the navy bars actually print. That copy is the one ported here, because it is
 * the one that is ahead; the Inventory app's version is the stale fork.
 *
 * Faithful port, not a redesign: this is a document a driver and a licensed
 * retailer sign at a loading dock, and the layout matches the paper form staff
 * already know. Two deliberate changes:
 *   - the logo path is absolute (`/rep-app/assets/...`) rather than relative,
 *     since this now renders from server routes rather than one static page;
 *   - delivery receipts still show WEIGHT and never price, per the decision in
 *     the Inventory app's commit 79a0f57.
 */

const LOGO_URL = "/rep-app/assets/icons/brand/logo-lmc.svg";

/**
 * The billing entity, printed on every delivery receipt whichever physical
 * warehouse the shipment actually left from.
 */
export const TLM_ENTITY = {
  name: "Familiar Ventures LLC / The Leopard Mark",
  address: "1300 First Street #368, Napa, CA 94559",
  phone: "(707) 261-0200",
} as const;

/** Standard NMFC density classes. An ESTIMATE for planning only. */
export const FREIGHT_CLASS_TABLE: ReadonlyArray<{ min: number; class: number }> = [
  { min: 50, class: 50 },
  { min: 35, class: 55 },
  { min: 30, class: 60 },
  { min: 22.5, class: 65 },
  { min: 15, class: 70 },
  { min: 13.5, class: 77.5 },
  { min: 12, class: 85 },
  { min: 10, class: 92.5 },
  { min: 8, class: 100 },
  { min: 6, class: 125 },
  { min: 4, class: 150 },
  { min: 2, class: 175 },
  { min: 1, class: 250 },
  { min: 0, class: 300 },
];

export function estimateFreightClass(
  dims: { l: number | string; w: number | string; h: number | string },
  units: number | string,
  weight: number | string,
): { density: number; freightClass: number } | null {
  const l = Number(dims.l);
  const w = Number(dims.w);
  const h = Number(dims.h);
  const u = Number(units) || 1;
  const wt = Number(weight);
  if (!l || !w || !h || !wt) return null;
  const cubicFeet = (l * w * h * u) / 1728;
  if (!cubicFeet) return null;
  const density = wt / cubicFeet;
  const match = FREIGHT_CLASS_TABLE.find((row) => density >= row.min);
  return { density: Math.round(density * 100) / 100, freightClass: match ? match.class : 300 };
}

/** HTML-escape. These documents interpolate customer-supplied names and notes. */
export function esc(v: unknown): string {
  if (v == null) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * "Case (12oz x24)" wrapped mid-parenthesis in a narrow column. Split
 * explicitly: the type on one line, the pack spec below it. Kegs and tap
 * handles have no parenthetical and render unchanged.
 */
function formatPackageType(pkg: string | null | undefined): string {
  const s = String(pkg ?? "");
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(s);
  if (!m) return esc(s);
  return `${esc(m[1].trim())}<br>${esc(m[2].trim())}`;
}

export interface DocLine {
  sku: string;
  description: string;
  package?: string | null;
  qty: number;
  lot?: string | null;
  weightPerUnit?: number | null;
  isKeg?: boolean;
}

export interface DeliveryReceiptData {
  docType: "delivery";
  bolNumber: string;
  invoiceNumber?: string | null;
  date: string;
  toAccount: {
    BusinessName?: string | null;
    LegalName?: string | null;
    DeliveryAddress?: string | null;
    Phone?: string | null;
    LicenseNumber?: string | null;
    PaymentMethod?: string | null;
    Terms?: string | null;
  };
  deliveryWindow?: string | null;
  receivingInstructions?: string | null;
  actor?: string | null;
  refNote?: string | null;
  notes?: string | null;
  lines: DocLine[];
}

export interface FacilityRecord {
  Name?: string | null;
  Address?: string | null;
  City?: string | null;
  State?: string | null;
  ShippingContact?: string | null;
  HasLoadingDock?: boolean | string | null;
  LiftgateRequired?: boolean | string | null;
  OutboundHours?: string | null;
  InboundHours?: string | null;
  OutboundInstructions?: string | null;
  InboundInstructions?: string | null;
}

export interface FreightBolData {
  docType: "freight";
  bolNumber: string;
  date: string;
  eventType: string;
  actor?: string | null;
  fromLoc?: FacilityRecord | null;
  toLoc?: FacilityRecord | null;
  fromName?: string | null;
  fromAddress?: string | null;
  toName?: string | null;
  toAddress?: string | null;
  carrier?: string | null;
  carrierPhone?: string | null;
  weight?: number | string | null;
  handlingUnitCount?: number | string | null;
  handlingUnitType?: string | null;
  dimensions?: string | null;
  freightClass?: string | number | null;
  freightClassEstimated?: boolean;
  commodityName?: string | null;
  nmfcNumber?: string | null;
  originAppointment?: string | null;
  destinationAppointment?: string | null;
  refNote?: string | null;
  notes?: string | null;
  lines: DocLine[];
}

export type DocumentData = DeliveryReceiptData | FreightBolData;

/** Dispatch on docType. The single entry point for both documents. */
export function renderBolHtml(d: DocumentData): string {
  return d.docType === "delivery" ? renderDeliveryReceiptHtml(d) : renderFreightBolHtml(d);
}

const DR_STYLE = `
.dr-doc{font-family:Arial,Helvetica,"Segoe UI",sans-serif;color:#1a1a1a;background:#fff;}
.dr-doc *{box-sizing:border-box;}
.dr-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:26px 26px 0;}
.dr-logo img{height:56px;display:block;}
.dr-title-block{text-align:right;}
.dr-title{font-size:16px;font-weight:800;color:#1b2c6b;letter-spacing:.01em;white-space:nowrap;}
.dr-ref{margin-top:8px;border:1.5px solid #1a1a1a;border-collapse:collapse;display:inline-table;font-size:11.5px;}
.dr-ref tr+tr td{border-top:1px solid #1a1a1a;}
.dr-ref td{padding:4px 9px;text-align:right;}
.dr-ref td.k{font-weight:700;border-right:1px solid #1a1a1a;}
.dr-ref td.v{font-weight:700;min-width:120px;}
.dr-body{padding:12px 26px 16px;}
.dr-bar{background:#1b2c6b;color:#fff;font-size:11.5px;font-weight:800;letter-spacing:.03em;padding:6px 12px;}
.dr-bar-alt{background:#d6dcef;color:#1b2c6b;font-size:11.5px;font-weight:800;letter-spacing:.03em;padding:6px 12px;}
.dr-block{border:1px solid #aeb7d6;border-top:none;margin-bottom:8px;}
.dr-2col{display:grid;grid-template-columns:1fr 1fr;}
.dr-row2{display:grid;grid-template-columns:1fr 1fr;}
.dr-party{padding:8px 15px;background:#f8f9fc;}
.dr-party+.dr-party{border-left:1px solid #aeb7d6;}
.dr-kv{display:grid;grid-template-columns:112px 1fr;gap:2px 8px;font-size:12px;margin-bottom:2px;}
.dr-kv .k{font-weight:700;color:#1b2c6b;}
.dr-kv .v.muted{color:#3c4260;font-weight:400;font-size:11.5px;}
.dr-instr{background:#ffee00;padding:6px 15px;}
.dr-instr .dr-kv{grid-template-columns:160px 1fr;margin-bottom:4px;}
.dr-instr .dr-kv:last-child{margin-bottom:0;}
table.dr-items{width:100%;border-collapse:collapse;}
table.dr-items thead td{background:#d6dcef;color:#1b2c6b;font-size:10.5px;font-weight:800;letter-spacing:.03em;padding:6px 11px;border-bottom:1px solid #aeb7d6;}
table.dr-items tbody td{padding:8px 11px;font-size:12px;background:#fff;vertical-align:top;}
table.dr-items td.num,table.dr-items th.num{text-align:right;white-space:nowrap;}
table.dr-items td.mono{font-weight:700;color:#1b2c6b;font-size:11px;white-space:nowrap;}
.dr-totcond{display:grid;grid-template-columns:1fr 1.35fr;}
.dr-totcond>div:first-child{border-right:1px solid #aeb7d6;}
.dr-totbox{padding:8px 15px;background:#f8f9fc;font-size:12px;}
.dr-totbox .row{display:flex;gap:8px;margin-bottom:4px;}
.dr-totbox .row .k{font-weight:700;color:#1b2c6b;min-width:100px;}
.dr-totbox .row .v{font-weight:700;}
.dr-totbox .note{margin-top:7px;font-size:10.5px;color:#3c4260;}
.dr-condbox{padding:8px 15px;background:#f8f9fc;font-size:12px;}
.dr-chkrow{display:flex;align-items:center;gap:9px;margin-bottom:7px;}
.dr-chk{width:13px;height:13px;border:1.5px solid #1b2c6b;flex:none;}
.dr-ekp{display:grid;grid-template-columns:1fr auto;align-items:stretch;}
.dr-ekp-qtyhead{grid-column:2;background:#1b2c6b;color:#fff;font-size:10.5px;font-weight:800;padding:6px 15px;display:flex;align-items:center;}
.dr-ekp-row{grid-column:1/-1;display:grid;grid-template-columns:40px 1fr 110px;align-items:center;background:#f8f9fc;border-top:1px solid #aeb7d6;}
.dr-ekp-row .cell{display:flex;justify-content:center;}
.dr-ekp-row .label{padding:7px 4px;font-size:12px;}
.dr-ekp-row .qty{border-left:1px solid #aeb7d6;min-height:28px;}
.dr-sig{display:grid;grid-template-columns:1fr 1fr;}
.dr-sig-col+.dr-sig-col{border-left:1px solid #aeb7d6;}
.dr-sig-field{padding:6px 15px;border-top:1px solid #aeb7d6;background:#f8f9fc;font-size:12px;font-weight:700;color:#1b2c6b;min-height:24px;}
.dr-sig-field:first-child{border-top:none;}
.dr-sig-field.tall{min-height:46px;}
.dr-ack{font-size:10px;color:#2a2a2a;line-height:1.5;margin-top:2px;}
@media print { .no-print{display:none !important;} body{background:#fff;} }
`;

export function renderDeliveryReceiptHtml(d: DeliveryReceiptData): string {
  const acct = d.toAccount ?? {};
  const lines = d.lines ?? [];

  // Accessories (tap handles) appear as a line but count toward neither
  // bucket, matching how the real paperwork excludes them from the totals.
  let kegQty = 0;
  let caseQty = 0;
  for (const l of lines) {
    if (l.isKeg) kegQty += Number(l.qty) || 0;
    else if (String(l.package ?? "").toLowerCase().includes("case")) caseQty += Number(l.qty) || 0;
  }

  const hasWeight = lines.some((l) => Number(l.weightPerUnit) > 0);
  const totalWeight = hasWeight
    ? lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.weightPerUnit) || 0), 0)
    : null;

  const rows = lines
    .map((l) => {
      const perUnit = Number(l.weightPerUnit) || 0;
      const lineWeight = (Number(l.qty) || 0) * perUnit;
      return `<tr>
        <td class="mono">${esc(l.sku)}</td>
        <td class="mono">${esc(l.lot || "—")}</td>
        <td>${esc(l.description)}</td>
        <td>${formatPackageType(l.package)}</td>
        <td class="num">${esc(String(l.qty))}</td>
        <td class="num">${perUnit > 0 ? perUnit : "—"}</td>
        <td class="num">${perUnit > 0 ? `${lineWeight} lbs` : "—"}</td>
      </tr>`;
    })
    .join("");

  const partyBlock = (
    title: string,
    name: string | null | undefined,
    sub: string,
    address: string | null | undefined,
    contact: string | null | undefined,
    extra = "",
  ) => `<div class="dr-party">
      <div class="dr-kv"><div class="k">${title}:</div><div class="v">${esc(name || "—")}</div></div>
      ${sub ? `<div class="dr-kv"><div class="k"></div><div class="v muted">${esc(sub)}</div></div>` : ""}
      ${address ? `<div class="dr-kv"><div class="k">Address:</div><div class="v">${esc(address)}</div></div>` : ""}
      ${contact ? `<div class="dr-kv"><div class="k">Phone:</div><div class="v">${esc(contact)}</div></div>` : ""}
      ${extra}
    </div>`;

  const instructions =
    d.deliveryWindow || d.receivingInstructions
      ? `<div class="dr-block">
      <div class="dr-bar">DELIVERY INSTRUCTIONS</div>
      <div class="dr-instr">
        <div class="dr-kv"><div class="k">Delivery Window:</div><div class="v">${esc(d.deliveryWindow || "N/A")}</div></div>
        <div class="dr-kv"><div class="k">Receiving Instructions:</div><div class="v">${esc(d.receivingInstructions || "N/A")}</div></div>
      </div>
    </div>`
      : "";

  const invoicedVia = [acct.PaymentMethod, acct.Terms].filter(Boolean).join(", ");

  return `<style>${DR_STYLE}</style>
<div class="dr-doc">
  <div class="dr-top">
    <div class="dr-logo"><img src="${LOGO_URL}" alt="The Leopard Mark" /></div>
    <div class="dr-title-block">
      <div class="dr-title">DELIVERY RECEIPT / BILL OF LADING</div>
      <table class="dr-ref">
        <tr><td class="k">Delivery #</td><td class="v">${esc(d.bolNumber)}</td></tr>
        ${d.invoiceNumber ? `<tr><td class="k">Invoice #</td><td class="v">${esc(d.invoiceNumber)}</td></tr>` : ""}
        <tr><td class="k">Date:</td><td class="v">${esc(d.date)}</td></tr>
      </table>
    </div>
  </div>
  <div class="dr-body">
    <div class="dr-block">
      <div class="dr-row2"><div class="dr-bar">SHIP FROM</div><div class="dr-bar" style="border-left:1px solid #1b2c6b;">SHIP TO</div></div>
      <div class="dr-2col">
        ${partyBlock("Business Name", TLM_ENTITY.name, "", TLM_ENTITY.address, TLM_ENTITY.phone)}
        ${partyBlock(
          "Business Name",
          acct.BusinessName,
          acct.LegalName && acct.LegalName !== acct.BusinessName ? acct.LegalName : "",
          acct.DeliveryAddress,
          acct.Phone,
          acct.LicenseNumber
            ? `<div class="dr-kv"><div class="k">License #</div><div class="v">${esc(String(acct.LicenseNumber))}</div></div>`
            : "",
        )}
      </div>
    </div>
    ${instructions}
    <div class="dr-block">
      <div class="dr-bar">PRODUCTS DELIVERED</div>
      <table class="dr-items"><thead><tr><td>SKU</td><td>LOT #</td><td>DESCRIPTION</td><td>PKG TYPE</td><td class="num">QTY</td><td class="num">WEIGHT (LBS)</td><td class="num">TOTAL WEIGHT</td></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="dr-block dr-totcond">
      <div>
        <div class="dr-bar">TOTALS</div>
        <div class="dr-totbox">
          <div class="row"><div class="k">Total Kegs:</div><div class="v">${kegQty}</div></div>
          <div class="row"><div class="k">Total Cases:</div><div class="v">${caseQty}</div></div>
          <div class="row"><div class="k">Total Units:</div><div class="v">${kegQty + caseQty}</div></div>
          <div class="row"><div class="k">Total Weight:</div><div class="v">${totalWeight !== null ? `${totalWeight} lbs` : "—"}</div></div>
          <div class="note">Keg Deposits and Case CRV will be collected when applicable</div>
        </div>
      </div>
      <div>
        <div class="dr-bar">CONDITION OF DELIVERY</div>
        <div class="dr-condbox">
          <div class="dr-chkrow"><span class="dr-chk"></span> Received in Good Condition</div>
          <div class="dr-chkrow"><span class="dr-chk"></span> Short Shipment</div>
          <div class="dr-chkrow"><span class="dr-chk"></span> Damaged / Refused Product</div>
          <div>Notes:</div>
        </div>
      </div>
    </div>
    <div class="dr-block dr-ekp">
      <div class="dr-bar">EMPTY KEG PICK-UP</div><div class="dr-ekp-qtyhead">QTY</div>
      <div class="dr-ekp-row"><div class="cell"><span class="dr-chk"></span></div><div class="label">1/2 BBL MicroStar Keg</div><div class="qty"></div></div>
      <div class="dr-ekp-row"><div class="cell"><span class="dr-chk"></span></div><div class="label">1/6 BBL MicroStar Keg</div><div class="qty"></div></div>
    </div>
    <div class="dr-block">
      <div class="dr-row2"><div class="dr-bar-alt">DELIVERED BY (DRIVER)</div><div class="dr-bar-alt" style="border-left:1px solid #1b2c6b;">RECEIVED BY (ACCOUNT)</div></div>
      <div class="dr-sig">
        <div class="dr-sig-col">
          <div class="dr-sig-field">Name (Print):</div>
          <div class="dr-sig-field">Date:</div>
          <div class="dr-sig-field tall">Signature:</div>
        </div>
        <div class="dr-sig-col">
          <div class="dr-sig-field">Name (Print):</div>
          <div class="dr-sig-field">Title:</div>
          <div class="dr-sig-field">Date</div>
          <div class="dr-sig-field">Signature:</div>
        </div>
      </div>
    </div>
    ${d.refNote || d.notes ? `<div class="dr-ack"><b>Ref:</b> ${esc(d.refNote || "")} ${esc(d.notes || "")}</div>` : ""}
    <div class="dr-ack"><b>ACKNOWLEDGMENT</b>: By signing above, receiver confirms all quantities were verified at time of delivery. Discrepancies must be noted at time of receipt. Alcohol must be received by a licensed entity. Signature constitutes acceptance of all listed items.${
      invoicedVia ? ` | Order will be invoiced via ${esc(invoicedVia)}.` : ""
    }</div>
  </div>
</div>`;
}

const BOL_STYLE = `
.bol-doc{font-family:Arial,Helvetica,"Segoe UI",sans-serif;color:#1a1a1a;background:#fff;border-radius:2px;}
.bol-doc *{box-sizing:border-box;}
.bol-top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:24px 26px 0;}
.bol-logo img{height:52px;display:block;}
.bol-doc-label{text-align:right;font-size:15px;font-weight:800;color:#1b2c6b;}
.bol-doc-label small{display:block;font-weight:400;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#545c68;margin-top:3px;}
.bol-body{padding:16px 26px 24px;}
.bol-ref{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #aeb7d6;margin-bottom:14px;}
.bol-ref-cell{padding:9px 14px;border-right:1px solid #aeb7d6;}
.bol-ref-cell:last-child{border-right:none;}
.bol-ref-cell .k{font-size:9.5px;text-transform:uppercase;letter-spacing:.08em;color:#545c68;}
.bol-ref-cell .v{font-size:12.5px;font-weight:700;margin-top:3px;}
.bol-parties{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aeb7d6;border-top:none;}
.bol-block{border:1px solid #aeb7d6;border-top:none;margin-bottom:14px;}
.bol-bar{background:#1b2c6b;color:#fff;font-size:11px;font-weight:800;letter-spacing:.03em;padding:6px 12px;}
.bol-party{padding:14px 18px;background:#f8f9fc;}
.bol-party+.bol-party{border-left:1px solid #aeb7d6;}
.bol-party .h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#1b2c6b;margin-bottom:8px;}
.bol-party .name{font-weight:700;font-size:13px;}
.bol-party .line{font-size:12px;color:#3c4260;margin-top:2px;}
.bol-party .line.muted{font-size:11px;}
.bol-freight{display:grid;grid-template-columns:repeat(3,1fr);}
.bol-freight-cell{padding:12px 18px;background:#f8f9fc;}
.bol-freight-cell+.bol-freight-cell{border-left:1px solid #aeb7d6;}
.bol-freight-cell .k{font-size:10px;color:#545c68;text-transform:uppercase;letter-spacing:.06em;}
.bol-freight-cell .v{font-size:13px;font-weight:700;margin-top:4px;}
table.bol-items{width:100%;border-collapse:collapse;}
table.bol-items thead td{background:#d6dcef;color:#1b2c6b;font-size:10px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:7px 12px;}
table.bol-items td.num,table.bol-items th.num{text-align:right;}
table.bol-items tbody td{padding:8px 12px;border-bottom:1px solid #eceef1;font-size:12.5px;background:#fff;}
.desc-code{color:#545c68;font-size:10.5px;}
.bol-totals{padding:10px 18px;border:1px solid #aeb7d6;border-top:none;display:flex;justify-content:flex-end;gap:24px;font-size:12.5px;background:#f8f9fc;}
.bol-totals b{font-size:14px;}
.bol-appt{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aeb7d6;border-top:none;}
.bol-appt>div{padding:10px 18px;font-size:12px;background:#f8f9fc;}
.bol-appt>div+div{border-left:1px solid #aeb7d6;}
.bol-appt .k{color:#545c68;font-size:10px;text-transform:uppercase;letter-spacing:.06em;}
.bol-appt .v{font-weight:700;margin-top:3px;}
.bol-sign{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aeb7d6;border-top:none;}
.bol-sign-col{padding:14px 18px;background:#f8f9fc;}
.bol-sign-col+.bol-sign-col{border-left:1px solid #aeb7d6;}
.bol-sign-col .h{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#1b2c6b;margin-bottom:12px;}
.bol-sign-field{margin-bottom:12px;}
.bol-sign-field .k{font-size:10px;color:#545c68;margin-bottom:3px;}
.bol-sign-field .rule{border-bottom:1px solid #b9bfc8;height:16px;}
.bol-notes{padding:10px 2px;font-size:11px;color:#545c68;}
.bol-caveat{padding:8px 18px;font-size:10px;color:#a06b1a;background:#fbf1da;border:1px solid #aeb7d6;border-top:none;}
@media print { .no-print{display:none !important;} body{background:#fff;} }
`;

export function renderFreightBolHtml(d: FreightBolData): string {
  const rows = d.lines
    .map(
      (l) => `<tr>
      <td><div class="desc-name">${esc(l.description)}</div><div class="desc-code">${esc(l.sku)}</div></td>
      <td>${formatPackageType(l.package)}</td>
      <td class="num">${esc(String(l.qty))}</td>
    </tr>`,
    )
    .join("");

  const totalUnits = d.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const isTrue = (v: unknown) => String(v).toUpperCase() === "TRUE" || v === true;

  /**
   * One party block whether the endpoint is a known Location or a typed-in
   * address (a customer dock, a third-party yard) — rather than a
   * labelled-but-blank box plus a second unlabelled one underneath.
   */
  const facilityBlock = (
    title: string,
    loc: FacilityRecord | null | undefined,
    hours: string | null | undefined,
    instr: string | null | undefined,
    manualName?: string | null,
    manualAddress?: string | null,
  ): string => {
    if (!loc) {
      if (!manualName) return `<div class="bol-party"><div class="h">${title}</div><div class="name">—</div></div>`;
      return `<div class="bol-party">
        <div class="h">${title}</div>
        <div class="name">${esc(manualName)}</div>
        ${manualAddress ? `<div class="line">${esc(manualAddress)}</div>` : ""}
      </div>`;
    }
    const dock = isTrue(loc.HasLoadingDock) ? "Loading dock available" : "No loading dock";
    const lift = isTrue(loc.LiftgateRequired) ? "Liftgate required" : "Liftgate not required";
    return `<div class="bol-party">
      <div class="h">${title}</div>
      <div class="name">${esc(loc.Name)}</div>
      <div class="line">${esc(loc.Address || `${loc.City ?? ""}, ${loc.State ?? ""}`)}</div>
      ${loc.ShippingContact ? `<div class="line muted">Contact: ${esc(loc.ShippingContact)}</div>` : ""}
      <div class="line muted">${dock} · ${lift}</div>
      ${hours ? `<div class="line muted">Hours: ${esc(hours)}</div>` : ""}
      ${instr ? `<div class="line muted">${esc(instr)}</div>` : ""}
    </div>`;
  };

  return `<style>${BOL_STYLE}</style>
<div class="bol-doc">
  <div class="bol-top">
    <div class="bol-logo"><img src="${LOGO_URL}" alt="The Leopard Mark" /></div>
    <div class="bol-doc-label">STRAIGHT BILL OF LADING<small>${esc(d.eventType)}</small></div>
  </div>
  <div class="bol-body">
    <div class="bol-ref">
      <div class="bol-ref-cell"><div class="k">BOL #</div><div class="v">${esc(d.bolNumber)}</div></div>
      <div class="bol-ref-cell"><div class="k">Date</div><div class="v">${esc(d.date)}</div></div>
      <div class="bol-ref-cell"><div class="k">Move Type</div><div class="v">${esc(d.eventType)}</div></div>
      <div class="bol-ref-cell"><div class="k">Prepared By</div><div class="v">${esc(d.actor || "—")}</div></div>
    </div>
    <div class="bol-parties">
      ${facilityBlock("Ship From", d.fromLoc, d.fromLoc?.OutboundHours, d.fromLoc?.OutboundInstructions, d.fromName, d.fromAddress)}
      ${facilityBlock("Ship To", d.toLoc, d.toLoc?.InboundHours, d.toLoc?.InboundInstructions, d.toName, d.toAddress)}
    </div>
    <div class="bol-block">
      <div class="bol-freight">
        <div class="bol-freight-cell"><div class="k">Carrier</div><div class="v">${esc(d.carrier || "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Carrier Phone</div><div class="v">${esc(d.carrierPhone || "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Weight</div><div class="v">${esc(d.weight ? `${d.weight} lbs` : "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Handling Units</div><div class="v">${esc(`${d.handlingUnitCount || "—"} ${d.handlingUnitType || ""}`.trim())}</div></div>
        <div class="bol-freight-cell"><div class="k">Dimensions (LxWxH, in)</div><div class="v">${esc(d.dimensions || "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Freight Class</div><div class="v">${esc(d.freightClass ?? "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Commodity</div><div class="v">${esc(d.commodityName || "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">NMFC #</div><div class="v">${esc(d.nmfcNumber || "—")}</div></div>
        <div class="bol-freight-cell"><div class="k">Freight Pay</div><div class="v">—</div></div>
      </div>
    </div>
    <div class="bol-block">
      <div class="bol-bar">COMMODITIES SHIPPED</div>
      <table class="bol-items"><thead><tr><td>Description</td><td>Package</td><td class="num">Qty</td></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="bol-totals">Total line items: <b>${d.lines.length}</b>&nbsp;&nbsp;&nbsp;Total units: <b>${totalUnits}</b></div>
    <div class="bol-appt">
      <div><div class="k">Origin Appointment #</div><div class="v">${esc(d.originAppointment || "—")}</div></div>
      <div><div class="k">Destination Appointment #</div><div class="v">${esc(d.destinationAppointment || "—")}</div></div>
    </div>
    ${d.refNote || d.notes ? `<div class="bol-notes"><b>Ref:</b> ${esc(d.refNote || "")} ${esc(d.notes || "")}</div>` : ""}
    ${d.freightClassEstimated ? `<div class="bol-caveat">Freight class is a density-based estimate — confirm with carrier before billing.</div>` : ""}
    <div class="bol-sign">
      <div class="bol-sign-col"><div class="h">Shipped By</div>
        <div class="bol-sign-field"><div class="k">Name (print)</div><div class="rule"></div></div>
        <div class="bol-sign-field"><div class="k">Signature / Date</div><div class="rule"></div></div></div>
      <div class="bol-sign-col"><div class="h">Received By</div>
        <div class="bol-sign-field"><div class="k">Name (print)</div><div class="rule"></div></div>
        <div class="bol-sign-field"><div class="k">Signature / Date</div><div class="rule"></div></div></div>
    </div>
  </div>
</div>`;
}

/**
 * Print scaffolding. `@page size: letter` is not cosmetic — without it the
 * output was at the mercy of whatever page size the browser assumed. The
 * `print-color-adjust: exact` rule is what keeps the navy bars and the yellow
 * instructions block from printing as bare outlines, since browsers drop
 * background colours on print by default.
 */
export const PRINT_PAGE_STYLE = `
@page { size: letter; margin: 0.4in; }
* { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; color-adjust: exact !important; }
html, body { margin: 0; padding: 0; }
body { background: #eceef1; }
.print-page { width: 100%; max-width: 8.2in; margin: 0 auto 24px; background: #fff; padding: 24px; box-sizing: border-box; }
.print-tip { max-width: 8.2in; margin: 0 auto 10px; padding: 8px 12px; background: #fff3cd; border: 1px solid #e0c46c; border-radius: 6px; font-size: 12px; color: #5c4a1a; font-family: Arial, sans-serif; }
@media print {
  body { background: #fff; }
  .print-page { max-width: none; width: 100%; padding: 0; margin: 0; }
}
`;

export const PRINT_TIP_HTML = `<div class="print-tip no-print">Tip: for a clean printout (no browser date/URL banner), open the print dialog&rsquo;s &ldquo;More settings&rdquo; and uncheck &ldquo;Headers and footers&rdquo;.</div>`;

/**
 * A complete printable page. One `.print-page` per document, page-broken
 * between them, so a day's print batch is one PDF of one-page receipts.
 */
export function renderPrintablePage(docs: DocumentData[], title: string): string {
  const pages = docs
    .map(
      (d, i) =>
        `<div class="print-page"${i < docs.length - 1 ? ' style="page-break-after: always; break-after: page;"' : ""}>${renderBolHtml(d)}</div>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_PAGE_STYLE}</style></head><body>${PRINT_TIP_HTML}${pages}</body></html>`;
}
