// My Purpose — the workshop shell. One question per screen, thin progress
// rail, module label + one-line rationale, quiet autosave indicator, and the
// three actions the spec names: Back / Save and continue later / Continue.
// Step bodies come from steps.tsx; state from usePurposeWorkshop.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { AnswerValue, StepDef } from "@/lib/purpose/types";
import { resolveDyn } from "@/lib/purpose/engine";
import { CRISIS_RESOURCES_COPY } from "@/lib/purpose/validators";
import {
  ERROR_COPY,
  IDENTITY_COMMITMENT_LEAD,
  MODULES,
  THREE_YEAR_HEADLINE,
} from "@/data/purpose-workshop-content";
import { QK } from "@/lib/purpose/questionKeys";
import { usePurposeWorkshop, type WorkshopMode } from "@/hooks/usePurposeWorkshop";
import type { PurposeProfileRow } from "@/hooks/usePurposeTable";
import type { SaveState } from "@/lib/purpose/autosave";
import { PurposeButton, PurposeLabel, PurposeProgress } from "./kit";
import {
  CurrencyStep,
  DualTextStep,
  EvidenceDateStep,
  IfThenStep,
  MultiSelectStep,
  ScaleStep,
  SingleSelectStep,
  StoryStep,
  TextStep,
  WhyStep,
} from "./steps";
import { ReviewScreen } from "./ReviewScreen";
import { CompletionScreen } from "./CompletionScreen";

function SavedIndicator({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  return (
    <span
      className={
        "text-xs " +
        (state === "device_only" ? "text-[var(--purpose-sand)]" : "text-[var(--purpose-ink-dim)]")
      }
      aria-live="polite"
    >
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Saved on this device"}
    </span>
  );
}

function CrisisNotice({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="fixed inset-0 z-[10000] flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <div className="purpose-surface w-full max-w-md rounded-2xl border border-[var(--purpose-line)] p-6 shadow-2xl">
        <h2 className="text-xl">{CRISIS_RESOURCES_COPY.headline}</h2>
        <p className="mt-3 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
          {CRISIS_RESOURCES_COPY.body}
        </p>
        <ul className="mt-4 space-y-2">
          {CRISIS_RESOURCES_COPY.resources.map((r) => (
            <li key={r} className="text-sm leading-relaxed text-[var(--purpose-ink)]">
              {r}
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end">
          <PurposeButton onClick={onDismiss}>I'm okay — continue</PurposeButton>
        </div>
      </div>
    </div>
  );
}

function StepBody(props: {
  step: StepDef;
  value: AnswerValue | undefined;
  answers: ReturnType<typeof usePurposeWorkshop>["answers"];
  onChange: (v: AnswerValue) => void;
}) {
  const { step } = props;
  switch (step.kind) {
    case "story":
      return <StoryStep {...props} />;
    case "single_select":
      return <SingleSelectStep {...props} />;
    case "multi_select":
      return <MultiSelectStep {...props} />;
    case "text":
      return <TextStep {...props} />;
    case "currency":
      return <CurrencyStep {...props} />;
    case "scale":
      return <ScaleStep {...props} />;
    case "dual_text":
      return <DualTextStep {...props} />;
    case "evidence_date":
      return <EvidenceDateStep {...props} />;
    case "if_then":
      return <IfThenStep {...props} />;
    case "why":
      return <WhyStep {...props} />;
    default:
      return null;
  }
}

export function PurposeWorkshop({
  profile,
  editStepKey,
  jumpToReview,
}: {
  profile: PurposeProfileRow;
  editStepKey?: string;
  jumpToReview?: boolean;
}) {
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(false);
  const mode: WorkshopMode = useMemo(
    () =>
      editStepKey
        ? {
            kind: "edit",
            stepKey: editStepKey,
            onDone: () => void navigate({ to: "/my-purpose" }),
          }
        : { kind: "flow" },
    [editStepKey, navigate],
  );
  const ws = usePurposeWorkshop(profile, mode);

  // ?review=1 — land on the final review (Purpose Home's "Review and edit").
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpToReview && !editStepKey && !ws.loading && !jumpedRef.current) {
      jumpedRef.current = true;
      ws.jumpToStep(QK.m5_review);
    }
  }, [jumpToReview, editStepKey, ws]);

  if (ws.loading) {
    return (
      <div className="purpose-surface min-h-dvh" aria-busy="true">
        <div className="mx-auto max-w-xl px-4 py-16 text-center text-[var(--purpose-ink-dim)]">
          Loading your answers…
        </div>
      </div>
    );
  }

  if (completed) {
    return <CompletionScreen answers={ws.answers} />;
  }

  const step = ws.step;
  if (!step) return null;
  const moduleMeta = MODULES.find((m) => m.key === step.module);
  const value = ws.answers[step.key];
  const isFirst = ws.index === 0;
  const isEdit = mode.kind === "edit";

  if (step.kind === "review") {
    return (
      <ReviewScreen
        profile={profile}
        answers={ws.answers}
        onEditStep={(key) => ws.jumpToStep(key)}
        onBack={ws.goBack}
        onSubmitted={() => {
          ws.onSubmitted();
          setCompleted(true);
        }}
        flush={ws.flush}
      />
    );
  }

  return (
    <div className="purpose-surface min-h-dvh">
      {ws.crisis && <CrisisNotice onDismiss={ws.dismissCrisis} />}
      <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-4 pt-safe">
        {/* Header: module label, %, saved state */}
        <div className="flex items-center justify-between gap-3 pt-5 pb-3">
          <PurposeLabel>
            {isEdit
              ? "Editing my Purpose"
              : moduleMeta
                ? `Part ${moduleMeta.index} of ${MODULES.length} — ${moduleMeta.label}`
                : ""}
          </PurposeLabel>
          <div className="flex items-center gap-3">
            <SavedIndicator state={ws.saveState} />
            {!isEdit && (
              <span className="text-xs tabular-nums text-[var(--purpose-ink-dim)]">{ws.progress}%</span>
            )}
          </div>
        </div>
        {!isEdit && <PurposeProgress pct={ws.progress} />}
        {!isEdit && moduleMeta && (
          <p className="mt-3 text-xs leading-relaxed text-[var(--purpose-ink-dim)]">{moduleMeta.rationale}</p>
        )}

        {/* Save-failure banner (spec §23) — session expiry gets its own copy. */}
        {ws.saveState === "device_only" && (
          <div className="mt-4 rounded-xl border border-[var(--purpose-sand)] bg-[color-mix(in_oklab,var(--purpose-sand)_10%,transparent)] p-3.5 text-sm leading-relaxed">
            {/jwt|token|expired|not authenticated/i.test(ws.lastSaveError() ?? "")
              ? ERROR_COPY.session_timeout
              : ERROR_COPY.save_failure}{" "}
            <button type="button" onClick={ws.retrySave} className="font-medium underline">
              Try again
            </button>
          </div>
        )}

        {/* The one question */}
        <div className="flex-1 pb-40">
          {step.key === QK.m3_three_year && (
            <p className="mt-7 text-sm font-medium text-[var(--purpose-sand)]">{THREE_YEAR_HEADLINE}</p>
          )}
          {step.key === QK.m5_identity_commitment && (
            <p className="mt-7 text-sm font-medium text-[var(--purpose-sand)]">
              {IDENTITY_COMMITMENT_LEAD}
            </p>
          )}
          {(() => {
            const prompt = resolveDyn(step.prompt, ws.answers);
            // 5.2's summary card has no headline — its storyBody is the card.
            if (!prompt) return null;
            return (
              <h1
                className={
                  "text-2xl leading-snug md:text-[1.7rem] " +
                  (step.key === QK.m3_three_year || step.key === QK.m5_identity_commitment
                    ? "mt-2"
                    : "mt-7")
                }
              >
                {prompt}
              </h1>
            );
          })()}
          <StepBody step={step} value={value} answers={ws.answers} onChange={(v) => ws.setAnswer(step.key, v)} />
          {step.afterAnswerNote && (value?.text ?? "").trim() && (
            <p className="mt-4 text-sm italic text-[var(--purpose-ink-dim)]">{step.afterAnswerNote}</p>
          )}
          {ws.issue && (
            <div
              className="mt-5 rounded-xl border border-[var(--purpose-tide)] bg-[color-mix(in_oklab,var(--purpose-tide)_10%,transparent)] p-4 text-sm leading-relaxed"
              role="status"
            >
              {ws.issue.message}
            </div>
          )}
        </div>

        {/* Sticky action bar */}
        <div className="fixed inset-x-0 bottom-0 border-t border-[var(--purpose-line)] bg-[color-mix(in_oklab,var(--purpose-navy-deep)_92%,transparent)] backdrop-blur px-4 pb-safe">
          <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 py-3">
            {isEdit ? (
              <Link to="/my-purpose" className="text-sm text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]">
                Cancel
              </Link>
            ) : (
              <PurposeButton tone="quiet" onClick={ws.goBack} disabled={isFirst} className="px-2">
                Back
              </PurposeButton>
            )}
            {!isEdit && (
              <button
                type="button"
                onClick={() => {
                  void ws.saveAndExit().then(() => navigate({ to: "/my-purpose" }));
                }}
                className="text-sm text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]"
              >
                Save and continue later
              </button>
            )}
            <PurposeButton
              onClick={() => ws.goNext()}
              className="min-w-28"
            >
              {isEdit ? "Save changes" : step.kind === "story" ? (step.cta ?? "Continue") : "Continue"}
            </PurposeButton>
          </div>
        </div>
      </div>
    </div>
  );
}
