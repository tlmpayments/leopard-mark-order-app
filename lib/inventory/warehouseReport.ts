import * as XLSX from 'xlsx';
import { isCoreProduct } from '@/lib/ops/scope';
export interface WarehouseRow { productCode:string; description:string; lot:string; packagingDate:string|null; onHand:number; onOrder:number; onHold:number; available:number; }
export function parseWarehouseReport(bytes: Uint8Array): WarehouseRow[] {
  const workbook=XLSX.read(bytes,{type:'array'});
  const sheet=workbook.Sheets['Lot Balances'];
  if(!sheet) throw new Error('Use the warehouse Lot Balances report. This file does not contain that tab.');
  const rows=XLSX.utils.sheet_to_json<Record<string,unknown>>(sheet,{defval:null});
  const parsed: WarehouseRow[]=[];
  for(const raw of rows){
    const row=Object.fromEntries(Object.entries(raw).map(([key,value])=>[key.trim(),value]));
    const productCode=String(row.Product??'').trim();
    if(!productCode || !isCoreProduct(productCode))continue;
    const number=(key:string)=>{
      const value=row[key];
      if(value===null || value===undefined || value==='')throw new Error(`${productCode}: missing ${key}. Review the report before saving.`);
      const n=Number(value);if(!Number.isFinite(n)||n<0)throw new Error(`${productCode}: invalid ${key}.`);return n;
    };
    const lot=String(row['P.O. No.']??'').trim();
    const match=/^\d{2}(?:CNT|SGB|SBG)(\d{2})(\d{2})(\d{2})\d+$/i.exec(lot);
    const date=match?`20${match[1]}-${match[2]}-${match[3]}`:null;
    const packagingDate=date && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0,10)===date?date:null;
    parsed.push({productCode,description:String(row.Description??productCode),lot,packagingDate,onHand:number('On Hand'),onOrder:number('On Order'),onHold:number('On Hold'),available:number('Available')});
  }
  if(!parsed.length)throw new Error('No Sunlight Groove, Cantinesca or glassware rows were found.');
  return parsed;
}
export interface WarehouseReport {kind:'warehouse_report';warehouseId:string;warehouseName:string;date:string;rows:WarehouseRow[];sourceFile:{name:string;base64:string};}
