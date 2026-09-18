import {expect,it} from 'vitest';
import * as XLSX from 'xlsx';
import {parseWarehouseReport} from '@/lib/inventory/warehouseReport';
const workbook=(rows:Record<string,unknown>[])=>{const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(rows),'Lot Balances');return XLSX.write(book,{type:'array',bookType:'xlsx'});};
const beer={Product:'TLM-CNT1AKHB01-M',Description:'Cantinesca half barrel','P.O. No.':'01CNT2607151','On Hand':8,'On Order':3,'On Hold':0,Available:5};
it('retains lots, packaging dates and warehouse commitments without a second deduction',()=>{
 const rows=parseWarehouseReport(workbook([beer,{...beer,Product:'GLW-PT-16-CNT-01',Description:'Pint glasses','P.O. No.':'0998308','On Hand':79,'On Order':2,Available:77},{...beer,Product:'TLM-XAL1AKHB01-M'}]));
 expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({lot:'01CNT2607151',packagingDate:'2026-07-15',onHand:8,onOrder:3,available:5});
 expect(rows[1]).toMatchObject({packagingDate:null,onHand:79,available:77});
});
it('does not silently replace missing quantities with zero',()=>{
 expect(()=>parseWarehouseReport(workbook([{...beer,'On Hand':null}]))).toThrow(/missing On Hand/);
});
