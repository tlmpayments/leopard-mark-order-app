import {afterAll,expect,it,vi} from 'vitest';
import {testDb,closeTestDb} from './helpers';
import {claimDueJobs} from '@/lib/jobs/queue';
vi.mock('@/lib/db',async()=>({db:(await import('./helpers')).testDb}));
const prefix='pilot-queue-'+Date.now();
afterAll(async()=>{await testDb.jobRun.deleteMany({where:{idempotencyKey:{startsWith:prefix}}});await closeTestDb();});
it('retains sending and migration jobs without attempting them while other work can proceed',async()=>{
 const now=new Date();
 for(const kind of ['ensure_stripe_customer','send_payment_setup_link','issue_invoice','stock_check'])await testDb.jobRun.create({data:{kind,idempotencyKey:prefix+kind,payloadJson:{},runAfter:now}});
 const claimed=await claimDueJobs(100,now);
 expect(claimed.map(j=>j.kind)).toEqual(['stock_check']);
 const paused=await testDb.jobRun.findMany({where:{idempotencyKey:{startsWith:prefix},kind:{not:'stock_check'}}});
 expect(paused.every(j=>j.status==='queued'&&j.attempts===0)).toBe(true);
});
