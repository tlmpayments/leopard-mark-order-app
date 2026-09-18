import Link from 'next/link';
import { db } from '@/lib/db';
import { importWarehouseReport } from './actions';
export default async function ImportPage({searchParams}:PageProps<'/ops/inventory/import'>){
 const p=await searchParams;const warehouses=await db.location.findMany({where:{active:true,type:'warehouse'},orderBy:{name:'asc'}});
 return <><div className="page-head"><div><h1>Add warehouse report</h1><p>Save the original sheet and its dated quantities to the online filing cabinet.</p></div><Link className="btn" href="/ops/inventory">Inventory</Link></div>
 {typeof p.error==='string'&&<div className="notice" role="alert">{p.error}</div>}
 <form action={importWarehouseReport} className="panel"><div className="list-tools"><label>Warehouse <select name="warehouseId" required><option value="">Choose warehouse</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label><label>Report date <input type="date" name="date" required /></label></div><div className="list-tools"><label>Lot Balances report <input type="file" name="file" accept=".xlsx" required /></label></div><p>Imports Sunlight Groove, Cantinesca and glassware, retaining every lot and the packaging dates encoded in beer lots.</p><p className="small muted">This saves a dated snapshot. It does not overwrite the running ledger, deduct orders or double-count the warehouse’s “On order” quantities. Reconcile those movements before treating the report as current availability.</p><button className="btn primary" type="submit">Save dated report</button></form></>;
}
