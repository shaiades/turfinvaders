// Screen 5.7 — the final editable review. Rows come from REVIEW_SECTIONS
// (one composition source shared with the completion screen and Purpose
// Home), each with an Edit jump back into its step. Submit requires the
// acknowledgement checkbox and runs the server-side completeness backstop.

import { useState } from "react";
import type { AnswerMap } from "@/lib/purpose/types";
import { REVIEW_SECTIONS, REVIEW_COPY } from "@/data/purpose-workshop-content";
import { requiredProfileComplete } from "@/lib/purpose/engine";
import { ALL_STEPS } from "@/data/purpose-workshop-content";
import { useSubmitPurpose } from "@/hooks/usePurposeProfile";
import type { PurposeProfileRow } from "@/hooks/usePurposeTable";
import { PurposeButton, PurposeCard, PurposeLabel } from "./kit";
import { QK } from "@/lib/purpose/questionKeys";

/** Review row label → the step its Edit button jumps into. Labels match
 *  REVIEW_SECTIONS exactly (the §16 layout). */
const EDIT_TARGETS: Record<string, string | undefined> = {
  "MY CURRENT CEILING": QK.m2_ceiling_amount,
  "THE FACT": QK.m2_fact_story,
  "THE STORY I AM QUESTIONING": QK.m2_fact_story,
  "MY THREE-YEAR POSSIBILITY": QK.m3_three_year,
  "MY ONE-YEAR TARGET": QK.m4_one_year_target,
  "MY SEVEN LEVELS OF WHY": QK.why_1,
  "MY CORE WHY": QK.why_7,
  "THE COST OF STAYING THE SAME": QK.why_5,
  "MY 90-DAY MISSION": QK.m4_mission_90,
  "MY PROFESSIONAL FOCUS": QK.m4_pro_focus,
  "MY PERSONAL SUPPORT FOCUS": QK.m4_personal_focus,
  "MY IF–THEN PLAN": QK.m5_if_then,
  "MY 90-DAY IDENTITY COMMITMENT": QK.m5_identity_commitment,
};

export function ReviewScreen({
  profile,
  answers,
  onEditStep,
  onBack,
  onSubmitted,
  flush,
}: {
  profile: PurposeProfileRow;
  answers: AnswerMap;
  onEditStep: (stepKey: string) => void;
  onBack: () => void;
  onSubmitted: () => void;
  flush: () => Promise<void>;
}) {
  const [ack, setAck] = useState(profile.workshop_completed);
  const [error, setError] = useState<string | null>(null);
  const submit = useSubmitPurpose(profile.user_id);
  const completeness = requiredProfileComplete(ALL_STEPS, answers);

  const rows = REVIEW_SECTIONS.map((s) => ({
    label: s.label,
    value: s.render(answers, { maskPrivate: false }),
    stepKey: EDIT_TARGETS[s.label],
  })).filter((r) => r.value != null && r.value !== "");

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-xl px-4 pt-safe pb-16">
        <PurposeLabel className="pt-6">Part 5 of 5 — Why It Matters and Keep the Promise</PurposeLabel>
        <h1 className="mt-3 text-2xl leading-snug">My Purpose — final review</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
          {REVIEW_COPY.displayLine}
        </p>

        <div className="mt-6 space-y-3">
          {rows.map((r) => (
            <PurposeCard key={r.label} className="p-4 md:p-5">
              <div className="flex items-start justify-between gap-3">
                <PurposeLabel>{r.label}</PurposeLabel>
                {r.stepKey && (
                  <button
                    type="button"
                    onClick={() => onEditStep(r.stepKey!)}
                    className="shrink-0 text-xs text-[var(--purpose-tide)] hover:underline"
                  >
                    Edit
                  </button>
                )}
              </div>
              <p className="mt-2 whitespace-pre-line text-base leading-relaxed">{r.value}</p>
            </PurposeCard>
          ))}
        </div>

        {!completeness.ok && (
          <div className="mt-6 rounded-xl border border-[var(--purpose-sand)] bg-[color-mix(in_oklab,var(--purpose-sand)_10%,transparent)] p-4 text-sm leading-relaxed">
            A few pieces are still blank — tap Back to finish them. ({completeness.missing.length}{" "}
            remaining)
          </div>
        )}

        <label className="mt-8 flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
            className="mt-1 size-5 accent-[var(--purpose-tide)]"
          />
          <span className="text-sm leading-relaxed">{REVIEW_COPY.ackText}</span>
        </label>

        {error && (
          <div className="mt-4 rounded-xl border border-[var(--purpose-sand)] p-4 text-sm leading-relaxed">
            {error}
          </div>
        )}

        <div className="mt-8 flex items-center justify-between gap-3">
          <PurposeButton tone="quiet" onClick={onBack}>
            Back
          </PurposeButton>
          <PurposeButton
            disabled={!ack || !completeness.ok || submit.isPending}
            onClick={() => {
              setError(null);
              void flush()
                .then(() => submit.mutateAsync())
                .then(() => onSubmitted())
                .catch((e: unknown) => {
                  setError(e instanceof Error ? e.message : "Could not save right now — try again.");
                });
            }}
          >
            {submit.isPending ? "Saving…" : "Save My Purpose"}
          </PurposeButton>
        </div>
      </div>
    </div>
  );
}
