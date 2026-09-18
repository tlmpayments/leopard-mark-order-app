'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { db } from '@/lib/db';
import { assertRole, LEDGER_ROLES } from '@/lib/ops/session';
import { saveWarehouseReport } from '@/lib/inventory/saveReport';
export async function importWarehouseReport(form:FormData):Promise<void>{
  await assertRole(LEDGER_ROLES);
  let id:string;
  try {
    const file=form.get('file');const date=String(form.get('date')??'');const warehouseId=String(form.get('warehouseId')??'');
    if(!(file instanceof File)||!file.name.toLowerCase().endsWith('.xlsx')||file.size>800000||file.size===0)throw new Error('Choose an XLSX report under 800 KB.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Choose the report date shown in the warehouse filename.');
    const warehouse=await db.location.findFirst({where:{id:warehouseId,active:true,type:'warehouse'}});
    if(!warehouse)throw new Error('Choose a warehouse.');
    const bytes=new Uint8Array(await file.arrayBuffer());
    const saved=await saveWarehouseReport(bytes,file.name,date,warehouse);id=saved.id;
  }catch(error){redirect('/ops/inventory/import?error='+encodeURIComponent(error instanceof Error?error.message:'The report could not be saved.'));}
  revalidatePath('/ops/inventory');revalidatePath('/ops/documents');
  redirect('/ops/inventory?report='+encodeURIComponent(id));
}
