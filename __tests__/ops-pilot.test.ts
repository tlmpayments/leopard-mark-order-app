import { describe, expect, it, vi } from 'vitest';
import { accountMarket, isCoreProduct, isStripeInvoice } from '@/lib/ops/scope';
import { assertSandboxKey, assertInvoiceSendingEnabled } from '@/lib/billing/pilot';
import { sendEmail } from '@/lib/email';

describe('LA pilot boundaries', () => {
  it('keeps LA separate from SF Bay and unassigned accounts', () => {
    expect(accountMarket('Los Angeles')).toBe('LA');
    expect(accountMarket('San Francisco')).toBe('BA');
    expect(accountMarket(null)).toBe('unknown');
    expect(accountMarket('San Diego')).toBe('unknown');
  });
  it('includes the two core beers and glassware, excluding experimental beers', () => {
    for(const sku of ['TLM-SGB1AC1224-6PK','TLM-CNT1AKHB01-M','GLW-PT-16-CNT-01','TLM-SBG1AKSB01-M']) expect(isCoreProduct(sku)).toBe(true);
    expect(isCoreProduct('TLM-XAL1AKHB01-M','Experimental IPA')).toBe(false);
  });
  it('does not treat a spreadsheet invoice identifier as Stripe verification', () => {
    expect(isStripeInvoice('sheet:INV26296')).toBe(false);
    expect(isStripeInvoice('in_test_invoice')).toBe(true);
  });
  it('rejects live, absent and malformed credentials', () => {
    for(const key of [undefined,'','sk_live_example','rk_live_example','invalid']) expect(()=>assertSandboxKey(key)).toThrow();
    expect(()=>assertSandboxKey('sk_test_example')).not.toThrow();
    expect(()=>assertSandboxKey('rk_test_example')).not.toThrow();
    expect(()=>assertInvoiceSendingEnabled()).toThrow(/paused/);
  });
  it('stops customer emails before any network request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      await expect(sendEmail({to:'test@example.com',subject:'Test',html:'Test'})).rejects.toThrow(/paused/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {vi.unstubAllGlobals();}
  });
});
