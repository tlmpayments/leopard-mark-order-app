import { BLOCKED_REASON_LABELS, STAGE_LABELS, stageToneClass, type PipelineStageResult } from "@/lib/pipeline";

/**
 * The stage chip. A blocked order shows BOTH facts — that it is blocked and
 * which stage it is blocked at — because "blocked" alone does not tell an
 * operator whether a truck is already booked.
 */
export function StageChip({ pipeline }: { pipeline: PipelineStageResult }) {
  const tone = stageToneClass(pipeline);
  if (pipeline.stage === "blocked" && pipeline.blockedReason) {
    const at = pipeline.underlyingStage ? STAGE_LABELS[pipeline.underlyingStage] : null;
    return (
      <span className={`stage ${tone}`} title={BLOCKED_REASON_LABELS[pipeline.blockedReason]}>
        <i />
        Blocked{at ? ` · ${at}` : ""}
      </span>
    );
  }
  return (
    <span className={`stage ${tone}`}>
      <i />
      {STAGE_LABELS[pipeline.stage]}
    </span>
  );
}
