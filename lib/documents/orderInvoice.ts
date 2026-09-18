import { db } from '@/lib/db';
import { buildPaperworkInvoice } from '@/lib/billing/paperworkInvoice';
import { renderInvoicePage } from '@/lib/billing/renderInvoice';
import { archiveDocument } from './archive';
import { todayYmd } from '@/lib/routes';
import { pacificDayRange } from '@/lib/scheduling';

/** A reviewable draft from the existing order, with its existing number and prices. */
export async function prepareOrderInvoice(orderId: string, preparedBy: string) {
  const order = await db.order.findUniqueOrThrow({where:{id:orderId}, include:{
    account:true, contact:true, salesRep:true, shipment:true,
    lines:{orderBy:{lineIndex:'asc'},include:{product:true}},
  }});
  if(!order.invoiceNumber) throw new Error('This order needs its source invoice number before preparing a document.');
  if(!order.lines.length) throw new Error('This order has no line items. Review the source sales rows first.');
  const custody = order.shipment ? await db.kegCustodyEntry.findMany({where:{shipmentId:order.shipment.id,delta:{lt:0}},include:{product:{select:{skuCode:true}}}}) : [];
  const emptiesBySku: Record<string,number> = {};
  for(const entry of custody) emptiesBySku[entry.product.skuCode]=(emptiesBySku[entry.product.skuCode]??0)+Math.abs(entry.delta);
  const historicDelivered = order.deliveryDate && order.deliveryDate < pacificDayRange(todayYmd()).start ? order.deliveryDate : null;
  const delivered = order.deliveredAt ?? historicDelivered;
  const date = delivered ?? order.scheduledFor ?? order.deliveryDate;
  const document = buildPaperworkInvoice({
    invoiceNumber:order.invoiceNumber, poDate:order.submittedAt ?? order.createdAt,
    deliveryDate: date ?? order.createdAt, terms:order.account.terms,
    taxExempt:order.account.taxExempt, salesRep:order.salesRep?.name,
    shipTo:{name:order.account.businessName,address:order.account.deliveryAddress ?? order.account.address,license:order.account.licenseNumber,phone:order.contact?.phoneE164},
    billTo:{name:order.account.legalEntity || order.account.businessName,address:order.account.address},
    lines:order.lines.map(line=>({skuCode:line.product.skuCode,productName:line.product.productName,
      formatLabel:line.product.formatLabel,isKeg:line.product.isKeg,depositAmount:line.product.depositAmount == null ? null : Number(line.product.depositAmount),
      qty:line.qty,unitPrice:Number(line.unitPrice),recordedLineTotal:Number(line.lineTotal),lot:line.lotNumber,
    })), emptiesBySku, preparedBy,
    notes:['Draft for internal review. Not sent to the customer.', order.notes].filter(Boolean).join('\n'),
  });
  document.draft=true;
  if(!delivered){document.dueDate=null;document.deliveryDate=date ? `Scheduled: ${document.deliveryDate}` : 'Not scheduled';}
  return archiveDocument({docNumber:order.invoiceNumber,docType:'invoice',html:renderInvoicePage([document],order.invoiceNumber),payload:JSON.parse(JSON.stringify(document)),accountId:order.accountId,orderId:order.id,summary:`${order.account.businessName} · Draft invoice`});
}
