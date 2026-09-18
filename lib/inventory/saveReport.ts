import { parseWarehouseReport, type WarehouseReport } from './warehouseReport';
import { archiveDocument } from '@/lib/documents/archive';
import { esc } from '@/lib/bol/render';
export async function saveWarehouseReport(bytes:Uint8Array,fileName:string,date:string,warehouse:{id:string;name:string}) {
    const rows=parseWarehouseReport(bytes);
    const payload:WarehouseReport={kind:'warehouse_report',warehouseId:warehouse.id,warehouseName:warehouse.name,date,rows,sourceFile:{name:fileName,base64:Buffer.from(bytes).toString('base64')}};
    const html=`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(warehouse.name)} inventory ${date}</title><style>body{font:14px Arial;color:#152847;margin:32px}table{width:100%;border-collapse:collapse}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}</style><h1>${esc(warehouse.name)} · ${date}</h1><p>Dated warehouse report. Source: ${esc(fileName)}. These quantities are not a live stock reconciliation.</p><table><thead><tr><th>Product</th><th>Lot / PO</th><th>Packaged</th><th>On hand</th><th>On order</th><th>On hold</th><th>Available</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.description)}<br>${esc(r.productCode)}</td><td>${esc(r.lot)}</td><td>${r.packagingDate??'—'}</td><td>${r.onHand}</td><td>${r.onOrder}</td><td>${r.onHold}</td><td>${r.available}</td></tr>`).join('')}</tbody></table></html>`;
    const saved=await archiveDocument({docNumber:`Inventory ${warehouse.id} ${date}`,docType:'inventory_report',html,payload:JSON.parse(JSON.stringify(payload)),summary:`${warehouse.name} · ${date} · ${rows.length} lot rows`});
    return saved;
}
