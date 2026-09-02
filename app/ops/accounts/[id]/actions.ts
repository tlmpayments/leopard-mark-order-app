"use server";

import { revalidatePath } from "next/cache";
import { LEDGER_ROLES, assertRole } from "@/lib/ops/session";
import { enqueue } from "@/lib/jobs/queue";

/**
 * Send the Stripe ACH setup link — the entirety of what ach.tlmbg.co did as a
 * separate deployment.
 *
 * Goes through the queue rather than calling Stripe inline so that the manual
 * button and the automatic rule share one idempotency key, one retry ladder and
 * one run log. That is also what enforces §6.4's "never two setup links within
 * 7 days": the handler owns that check, and there is only one handler.
 */
export async function sendSetupLinkAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  const accountId = String(formData.get("accountId"));

  await enqueue(
    "send_payment_setup_link",
    accountId,
    { accountId, requestedBy: user.id },
    { accountId },
  );

  revalidatePath(`/ops/accounts/${accountId}`);
}
