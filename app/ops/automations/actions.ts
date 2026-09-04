"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { ADMIN_ROLES, LEDGER_ROLES, assertRole } from "@/lib/ops/session";
import { discardJob, retryJob } from "@/lib/jobs/queue";
import { AUTOMATION_RULES } from "@/lib/automations";
import { kickJobs } from "@/lib/jobs/kick";

/** Toggling an automation is an admin action and is recorded with who did it. */
export async function toggleRuleAction(formData: FormData): Promise<void> {
  const user = await assertRole(ADMIN_ROLES);
  const key = String(formData.get("key"));
  const def = AUTOMATION_RULES.find((r) => r.key === key);

  // A rule that is not in the catalogue cannot be toggled, and a rule marked
  // non-toggleable cannot be turned off: the Sheet mirror going quiet would
  // desynchronise the spreadsheet the business still reads from, which is not
  // a switch worth offering.
  if (!def && !key.startsWith("auto_schedule_region:")) throw new Error(`Unknown automation: ${key}`);
  if (def && !def.toggleable) throw new Error(`${def.name} is load-bearing and cannot be switched off`);

  const enabled = formData.get("enabled") === "1";
  await db.automationRule.upsert({
    where: { key },
    create: { key, enabled, updatedByUserId: user.id },
    update: { enabled, updatedByUserId: user.id },
  });
  revalidatePath("/ops/automations");
  revalidatePath("/ops");
}

export async function retryJobAction(formData: FormData): Promise<void> {
  const user = await assertRole(LEDGER_ROLES);
  await retryJob(String(formData.get("jobId")), user.id);
  // Drain now rather than waiting for the daily cron (see lib/jobs/kick.ts).
  kickJobs();

  revalidatePath("/ops/automations");
  revalidatePath("/ops");
}

export async function discardJobAction(formData: FormData): Promise<void> {
  await assertRole(ADMIN_ROLES);
  await discardJob(String(formData.get("jobId")));
  revalidatePath("/ops/automations");
  revalidatePath("/ops");
}
