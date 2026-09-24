// §17 — the completion screen. Calm confirmation, no confetti (spec rule).

import { Link } from "@tanstack/react-router";
import type { AnswerMap } from "@/lib/purpose/types";
import { COMPLETION_COPY, REVIEW_SECTIONS } from "@/data/purpose-workshop-content";
import { QK } from "@/lib/purpose/questionKeys";
import { PurposeCard, PurposeLabel } from "./kit";

/** §17: target, Core Why, mission, the belief being questioned (the 3.5
 *  answer — not the 2.4 story), and the if–then plan. */
export function CompletionScreen({ answers }: { answers: AnswerMap }) {
  const bySection = new Map(REVIEW_SECTIONS.map((s) => [s.label, s]));
  const fromReview = (label: string) =>
    bySection.get(label)?.render(answers, { maskPrivate: false }) ?? null;
  const rows = [
    { label: "MY ONE-YEAR TARGET", value: fromReview("MY ONE-YEAR TARGET") },
    { label: "MY CORE WHY", value: fromReview("MY CORE WHY") },
    { label: "MY 90-DAY MISSION", value: fromReview("MY 90-DAY MISSION") },
    { label: "THE BELIEF I AM QUESTIONING", value: answers[QK.m3_belief_to_question]?.text ?? null },
    { label: "MY IF–THEN PLAN", value: fromReview("MY IF–THEN PLAN") },
  ].filter((r): r is { label: string; value: string } => !!r.value);

  return (
    <div className="purpose-surface min-h-dvh">
      <div className="mx-auto w-full max-w-xl px-4 pt-safe pb-16">
        <h1 className="pt-12 text-3xl leading-tight">{COMPLETION_COPY.headline}</h1>
        <p className="mt-4 text-base leading-relaxed text-[var(--purpose-ink-dim)]">
          {COMPLETION_COPY.body}
        </p>

        <div className="mt-8 space-y-3">
          {rows.map((r) => (
            <PurposeCard key={r.label} className="p-4 md:p-5">
              <PurposeLabel>{r.label}</PurposeLabel>
              <p className="mt-2 whitespace-pre-line text-base leading-relaxed">{r.value}</p>
            </PurposeCard>
          ))}
        </div>

        <p className="mt-8 text-sm italic leading-relaxed text-[var(--purpose-ink-dim)]">
          {COMPLETION_COPY.closing}
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Link
            to="/my-purpose"
            className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--purpose-tide)] px-5 text-base font-semibold text-[var(--purpose-navy-deep)] hover:brightness-110 sm:min-w-56"
          >
            {COMPLETION_COPY.primaryCta}
          </Link>
          <Link
            to="/my-purpose/workshop"
            search={{ review: true }}
            className="text-center text-sm text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]"
          >
            {COMPLETION_COPY.secondaryCta}
          </Link>
        </div>
      </div>
    </div>
  );
}
