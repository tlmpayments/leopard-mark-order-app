import { afterAll, describe, expect, it } from 'vitest';
import { archiveDocument } from '@/lib/documents/archive';
import { closeTestDb, testDb } from './helpers';
const prefix = `ARCHIVE-TEST-${Date.now()}`;
afterAll(async()=>{await testDb.archivedDocument.deleteMany({where:{docNumber:{startsWith:prefix}}});await closeTestDb();});
describe('online document archive',()=>{
 it('keeps original content after a corrected version is created',async()=>{
   const input={docNumber:prefix,docType:'invoice',html:'<html>2 kegs · LOT-1 · $384</html>',payload:{qty:2,lot:'LOT-1'},accountId:'fixture-account',orderId:'fixture-order',summary:'Test invoice'};
   const original=await archiveDocument(input,testDb);
   const corrected=await archiveDocument({...input,html:'<html>3 kegs · LOT-2 · $576</html>',payload:{qty:3,lot:'LOT-2'}},testDb);
   expect(corrected.id).not.toBe(original.id);
   const read=await testDb.archivedDocument.findUniqueOrThrow({where:{id:original.id}});
   expect(read.renderedHtml).toBe(input.html);
   expect(read.payloadJson).toEqual(input.payload);
   expect(read.orderId).toBe('fixture-order');
 });
 it('reprinting identical content reuses the saved version',async()=>{
   const input={docNumber:prefix+'-repeat',docType:'straight_bol',html:'<html>LOT-1</html>',payload:{lot:'LOT-1'},summary:'Repeat'};
   const a=await archiveDocument(input,testDb); const b=await archiveDocument(input,testDb);
   expect(b.id).toBe(a.id);
   expect(await testDb.archivedDocument.count({where:{docNumber:input.docNumber}})).toBe(1);
 });
 it('rolls document metadata back if saving its archive fails',async()=>{
   await expect(testDb.$transaction(async tx=>{
     await archiveDocument({docNumber:prefix+'-rollback',docType:'invoice',html:'<html>Test</html>',payload:{},summary:'Test'},tx);
     throw new Error('Simulated generation failure');
   })).rejects.toThrow('Simulated generation failure');
   expect(await testDb.archivedDocument.count({where:{docNumber:prefix+'-rollback'}})).toBe(0);
 });
});
