import { sparklinePath } from "@/lib/ops/format";

/** A 30-day sparkline. Inline SVG — a charting library for one shape is not a
 *  trade worth making, and this keeps the KPI row free of client JS. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const { line, area, last } = sparklinePath(values);
  return (
    <svg viewBox="0 0 200 36" preserveAspectRatio="none" role="img" aria-label="30-day trend">
      <path d={area} fill="rgba(57,135,229,.14)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3" fill="var(--accent-ink)" />
    </svg>
  );
}
