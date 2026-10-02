import { SURVEY } from "@/lib/prospects/sheetColumns";

/**
 * The survey as the question list says it may look.
 *
 * Only known questions survive, a choice question keeps only one of its own
 * choices, a yes/no only Yes or No, a date only YYYY-MM-DD, and free text is
 * capped. Anything else is dropped rather than rejected: a phone that is one
 * app version behind should lose a stale answer, not the visit it came with.
 * Empty answers are dropped too, so "cleared" and "never answered" are one thing.
 */
export function cleanSurvey(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const q of SURVEY) {
    const v = input[q.key];
    if (typeof v !== "string") continue;
    const value = v.trim().slice(0, 500);
    if (!value) continue;
    if (q.kind === "choice" && !q.choices?.includes(value)) continue;
    if (q.kind === "yesno" && value !== "Yes" && value !== "No") continue;
    if (q.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    out[q.key] = value;
  }
  return Object.keys(out).length ? out : null;
}
