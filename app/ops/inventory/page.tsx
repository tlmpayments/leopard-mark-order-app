import Link from "next/link";
import type { WarehouseReport } from "@/lib/inventory/warehouseReport";
import { db } from "@/lib/db";
import { availableForDelivery, stockByLocation } from "@/lib/inventory";
import { isCoreProduct } from "@/lib/ops/scope";
import { sheetLink } from "@/lib/ops/sourceLinks";
import { stamp } from "@/lib/ops/format";
export const dynamic = "force-dynamic";
export default async function InventoryPage({ searchParams }: PageProps<"/ops/inventory">) {
  const params = await searchParams;
  const selected = typeof params.warehouse === "string" ? params.warehouse : "";
  const [stock, available, locations, events, snapshots, reports] = await Promise.all([
    stockByLocation(), availableForDelivery(),
    db.location.findMany({ where: { active: true, type: "warehouse" }, orderBy: { name: "asc" } }),
    db.inventoryEvent.findMany({ orderBy: { occurredAt: "desc" }, include: { product: true, account: { select: { businessName: true } }, orderLine: { select: { orderId: true } } } }),
    db.inventorySnapshot.findMany({ where: { source: "leopard_mark_warehouse" }, orderBy: { snapshotDate: "desc" } }),
    db.archivedDocument.findMany({where:{docType:"inventory_report"},orderBy:{createdAt:"desc"},select:{id:true,payloadJson:true}}),
  ]);
  const products = await db.product.findMany({ where: { active: true }, orderBy: { skuCode: "asc" } });
  const latest = snapshots[0]?.snapshotDate.getTime();
  const reportRows = snapshots.filter(s => s.snapshotDate.getTime() === latest && isCoreProduct(s.rawProductCode));
  const warehouses = locations.filter(w => !selected || w.id === selected);
  const recent = events.filter(e => isCoreProduct(e.product.skuCode, e.product.productName) && (!selected || e.fromLocationId === selected || e.toLocationId === selected)).slice(0, 40);
  const latestReports = new Map<string, {id:string; report:WarehouseReport}>();
  for(const saved of reports){const report=saved.payloadJson as unknown as WarehouseReport;if(report.kind!=="warehouse_report")continue;const previous=latestReports.get(report.warehouseId);if(!previous || report.date>previous.report.date)latestReports.set(report.warehouseId,{id:saved.id,report});}
  return <>
    <div className="page-head"><div><h1>Inventory</h1><p>Sunlight Groove, Cantinesca and glassware. Open a warehouse to review quantities.</p></div><div className="actions"><Link className="btn primary" href="/ops/inventory/import">Add warehouse report</Link><a className="btn" href={sheetLink("Inventory Ledger")} target="_blank" rel="noopener noreferrer">Open inventory ledger</a></div></div>
    <form className="list-tools"><select aria-label="Warehouse" name="warehouse" defaultValue={selected}><option value="">All warehouses</option>{locations.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select><button className="btn">Apply</button><a href={sheetLink("Production")} target="_blank" rel="noopener noreferrer">Production records</a></form>
    {[...latestReports.values()].filter(({report})=>!selected||report.warehouseId===selected).map(({id,report})=><section className="panel flush warehouse-panel" key={id}><div className="panel-head"><div><h2>{report.warehouseName}</h2><p className="small muted">Warehouse report · {report.date} · dated quantities</p></div><div className="actions"><a href={`/api/documents/archive/${id}`} target="_blank" rel="noopener noreferrer">Saved report</a><a href={`/api/documents/archive/${id}?source=1`}>Original Excel</a></div></div><div className="tblwrap"><table className="tbl"><thead><tr><th>Product</th><th>Format</th><th className="r">On hand</th><th className="r">Available then</th></tr></thead><tbody>{reportTotals(report).map(r=><tr key={r.code}><td><b>{r.name}</b></td><td>{r.format}</td><td className="r num">{r.onHand}</td><td className="r num"><span className="pill neutral">{r.available}</span></td></tr>)}</tbody></table></div><details style={{padding:"16px 18px"}}><summary>Lot details ({report.rows.length})</summary><div className="tblwrap"><table className="tbl"><thead><tr><th>Product / SKU</th><th>Lot / P.O.</th><th>Packaged</th><th className="r">On hand</th><th className="r">On order</th><th className="r">Available then</th></tr></thead><tbody>{report.rows.map((r,i)=><tr key={i}><td><b>{r.description}</b><div className="small muted">{r.productCode}</div></td><td>{r.lot||"—"}</td><td>{r.packagingDate||"—"}</td><td className="r num">{r.onHand}</td><td className="r num">{r.onOrder}</td><td className="r num"><span className="pill neutral">{r.available}</span></td></tr>)}</tbody></table></div></details><p className="small muted" style={{padding:"0 18px 16px"}}>Match deliveries since this report and the warehouse’s existing commitments before promising stock. Beer lot dates are packaging dates; production records hold brew dates.</p></section>)}
    <details className="panel" style={{marginBottom:24}}><summary>App ledger balances · reconcile with warehouse reports</summary><p className="small muted">These balances only include recorded app movements. Missing opening stock or historical deliveries can make them incomplete.</p>
    {warehouses.map(w => <section className="panel flush warehouse-panel" key={w.id}><div className="panel-head"><h2>{w.name}</h2><span className="small muted">{w.city} · {w.id}</span></div><div className="tblwrap"><table className="tbl"><thead><tr><th>Product</th><th>Format</th><th>SKU</th><th className="r">On hand</th><th className="r">Reserved</th><th className="r">Available</th></tr></thead><tbody>
      {products.filter(p => isCoreProduct(p.skuCode, p.productName)).map(p => { const quantity = stock.find(s => s.locationId === w.id && s.productId === p.id); const a = available.find(s => s.locationId === w.id && s.productId === p.id); return <tr key={p.id}><td><a href={sheetLink("Inventory Ledger")} target="_blank" rel="noopener noreferrer"><b>{p.productName}</b></a></td><td>{p.formatLabel}</td><td className="small">{p.skuCode}</td><td className="r num">{quantity?.onHand ?? "—"}</td><td className="r num">{a?.reserved ?? "—"}</td><td className="r num"><span className={`pill ${a ? a.available > 0 ? "good" : "warn" : "neutral"}`}>{a?.available ?? "Unconfirmed"}</span></td></tr>; })}
    </tbody></table></div></section>)}
    </details>
    {!warehouses.length && <div className="empty">No warehouse matches this selection.</div>}
    <p className="small muted">These running balances come from the app ledger. A blank balance is unconfirmed. Warehouse report balances are dated snapshots and are not added to the ledger a second time.</p>
    {!!reportRows.length && <details className="panel" style={{ marginTop: 24 }} open><summary>Wilmington warehouse report · {snapshots[0].snapshotDate.toISOString().slice(0, 10)}</summary><div className="tblwrap"><table className="tbl"><thead><tr><th>Warehouse product code</th><th>Lot / P.O.</th><th className="r">On hand</th><th className="r">On order</th><th className="r">Available</th></tr></thead><tbody>{reportRows.map(r => <tr key={r.id}><td>{r.rawProductCode}</td><td>{r.lotRef ?? "Not recorded"}</td><td className="r num">{r.onHand?.toString() ?? "—"}</td><td className="r num">{r.onOrder?.toString() ?? "—"}</td><td className="r num">{r.available?.toString() ?? "—"}</td></tr>)}</tbody></table></div><p className="small muted">The date inside the beer lot number is the packaging date. Match brewery production records for brew date. Match “On order” commitments before adding reservations.</p></details>}
    <section className="panel flush" style={{ marginTop: 24 }}><div className="panel-head"><h2>Recent stock history</h2><a href={sheetLink("Inventory Ledger")} target="_blank" rel="noopener noreferrer">Source ledger</a></div><div className="tblwrap"><table className="tbl"><thead><tr><th>Date</th><th>Product / lot</th><th>Movement</th><th className="r">Quantity</th><th>Destination / order</th><th>Source</th></tr></thead><tbody>{recent.map(e => <tr key={e.id}><td className="small">{stamp(e.occurredAt)}</td><td>{e.product.productName}<div className="small muted">{e.lotNumber ?? "Lot not recorded"}</div></td><td>{e.type}</td><td className="r num">{e.qty}</td><td>{e.orderLine ? <Link href={`/ops/orders/${e.orderLine.orderId}`}>{e.account?.businessName ?? "Open order"}</Link> : e.account?.businessName ?? e.toLocationId ?? "—"}</td><td>{e.sheetRowRef ? <a href={sheetLink("Inventory Ledger", e.sheetRowRef)} target="_blank" rel="noopener noreferrer">Sheet row {e.sheetRowRef}</a> : e.refNote ?? "App entry"}</td></tr>)}</tbody></table>{!recent.length && <div className="empty">No stock movements recorded for this selection.</div>}</div></section>
  </>;
}

function reportTotals(report:WarehouseReport) {
  const groups=new Map<string,{code:string;name:string;format:string;onHand:number;available:number}>();
  for(const row of report.rows){
    const code=row.productCode.replace('TLM-SBG','TLM-SGB');
    const value=groups.get(code)??{code,name:/GLW/.test(code)?'Glassware':/CNT/.test(code)?'Cantinesca':'Sunlight Groove',format:/GLW/.test(code)?'Cases · 24 glasses':/AKHB/.test(code)?'½ barrel kegs':/AKSB/.test(code)?'⅙ barrel kegs':'Cases',onHand:0,available:0};
    value.onHand+=row.onHand;value.available+=row.available;groups.set(code,value);
  }
  return [...groups.values()];
}
