// My Purpose — one renderer per step kind. Every renderer is a controlled
// view over (StepDef, AnswerValue) → onChange(AnswerValue); navigation,
// validation callouts, and autosave all live in the shell. Copy comes from
// the step definitions — nothing user-facing is hard-coded here.

import { useMemo, useState } from "react";
import type { AnswerMap, AnswerValue, Option, StepDef, Visibility } from "@/lib/purpose/types";
import { resolveDyn, selectionsOf } from "@/lib/purpose/engine";
import { detectIDontKnow } from "@/lib/purpose/validators";
import {
  CORE_WHY_SCAFFOLD,
  FACT_STORY_COPY,
  IF_PREFILLS,
  SCALE_ANCHORS,
  SUPPORT_CONTEXT_PROMPT,
  ifThenQuestion,
  primaryObstacle,
} from "@/data/purpose-workshop-content";
import { QK } from "@/lib/purpose/questionKeys";
import {
  PurposeChip,
  PurposeInput,
  PurposeLabel,
  PurposeOptionCard,
  PurposeTextarea,
} from "./kit";

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export type StepProps = {
  step: StepDef;
  value: AnswerValue | undefined;
  answers: AnswerMap;
  onChange: (value: AnswerValue) => void;
};

// ---------------------------------------------------------------------------
// Shared atoms
// ---------------------------------------------------------------------------

export function VisibilityToggle({
  visibility,
  onChange,
}: {
  visibility: Visibility;
  onChange: (v: Visibility) => void;
}) {
  return (
    <div className="mt-4">
      <PurposeLabel className="mb-2">Who can see this</PurposeLabel>
      <div className="flex flex-wrap gap-2">
        <PurposeChip selected={visibility === "private_to_rep"} onClick={() => onChange("private_to_rep")}>
          Private to me
        </PurposeChip>
        <PurposeChip
          selected={visibility === "leadership_shared"}
          onClick={() => onChange("leadership_shared")}
        >
          Share with Tyler and Shai
        </PurposeChip>
      </div>
    </div>
  );
}

function Helper({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="mt-2 text-sm leading-relaxed text-[var(--purpose-ink-dim)]">{text}</p>;
}

function Examples({ items, label = "Examples" }: { items?: readonly string[]; label?: string }) {
  if (!items?.length) return null;
  return (
    <div className="mt-4 rounded-xl border border-[var(--purpose-line)] p-4">
      <PurposeLabel className="mb-2">{label}</PurposeLabel>
      <ul className="space-y-1.5">
        {items.map((e) => (
          <li key={e} className="text-sm leading-relaxed text-[var(--purpose-ink-dim)]">
            {e}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One rotating reflection prompt under a field (screen 2.2) — quiet, cycles
 *  on tap, never auto-fills the answer. */
function ReflectionPrompts({ prompts }: { prompts?: string[] }) {
  const [i, setI] = useState(0);
  if (!prompts?.length) return null;
  return (
    <button
      type="button"
      onClick={() => setI((n) => (n + 1) % prompts.length)}
      className="mt-3 block text-left text-sm italic text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]"
    >
      {prompts[i % prompts.length]}
      {prompts.length > 1 && <span className="ml-2 not-italic opacity-60">↻</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// story
// ---------------------------------------------------------------------------

export function StoryStep({ step, answers }: StepProps) {
  const body = step.storyBody ? resolveDyn(step.storyBody, answers) : "";
  const footer = step.footer ? resolveDyn(step.footer, answers) : "";
  return (
    <div>
      {body
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((p, i) => (
          <p key={i} className="mt-4 text-base leading-relaxed text-[var(--purpose-ink)] first:mt-0">
            {p}
          </p>
        ))}
      {step.factStoryCard && (
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--purpose-line)] p-4">
            <PurposeLabel className="mb-1.5 text-[var(--purpose-tide)]">
              {step.factStoryCard.factLabel}
            </PurposeLabel>
            <p className="text-base">{step.factStoryCard.fact}</p>
          </div>
          <div className="rounded-xl border border-[var(--purpose-line)] p-4">
            <PurposeLabel className="mb-1.5 text-[var(--purpose-sand)]">
              {step.factStoryCard.storyLabel}
            </PurposeLabel>
            <p className="text-base">{step.factStoryCard.story}</p>
          </div>
        </div>
      )}
      {footer && <p className="mt-6 text-sm italic leading-relaxed text-[var(--purpose-ink-dim)]">{footer}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// single_select
// ---------------------------------------------------------------------------

export function SingleSelectStep({ step, value, answers, onChange }: StepProps) {
  const options = step.options ? resolveDyn(step.options, answers) : [];
  const selected = value?.text;
  const otherText = (asObj(value?.json).otherText as string | undefined) ?? "";
  return (
    <div className="mt-6 space-y-2.5">
      {options.map((o) => (
        <PurposeOptionCard
          key={o.value}
          selected={selected === o.value}
          onClick={() => onChange({ ...value, text: o.value })}
        >
          {o.label}
        </PurposeOptionCard>
      ))}
      {selected === "other" && (
        <PurposeInput
          value={otherText}
          onChange={(e) => onChange({ ...value, text: selected, json: { otherText: e.target.value } })}
          placeholder="Say it in your words (optional)"
          aria-label="Tell us more"
        />
      )}
      <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// multi_select (incl. the support-request variant with optional context)
// ---------------------------------------------------------------------------

export function MultiSelectStep({ step, value, answers, onChange }: StepProps) {
  const options = step.options ? resolveDyn(step.options, answers) : [];
  const selections = selectionsOf(value);
  const max = step.maxSelections ?? options.length;
  const isSupportRequest = step.key === "m5_support_request";
  const context = (asObj(value?.json).context as string | undefined) ?? "";

  const emit = (next: string[], nextContext?: string) => {
    if (isSupportRequest) {
      onChange({ json: { selections: next, ...(nextContext ?? context ? { context: nextContext ?? context } : {}) } });
    } else {
      onChange({ json: next });
    }
  };

  const toggle = (v: string) => {
    if (selections.includes(v)) return emit(selections.filter((s) => s !== v));
    if (selections.length >= max) return; // cap reached — first pick is primary
    emit([...selections, v]);
  };

  return (
    <div className="mt-6 space-y-2.5">
      <PurposeLabel>
        Choose up to {max}
        {selections.length > 0 && ` · ${selections.length} selected`}
      </PurposeLabel>
      {options.map((o) => {
        const idx = selections.indexOf(o.value);
        return (
          <PurposeOptionCard
            key={o.value}
            selected={idx !== -1}
            onClick={() => toggle(o.value)}
            disabled={idx === -1 && selections.length >= max}
          >
            <span className="flex items-center justify-between gap-3">
              <span>{o.label}</span>
              {idx === 0 && selections.length > 1 && (
                <span className="shrink-0 text-xs text-[var(--purpose-sand)]">main one</span>
              )}
            </span>
          </PurposeOptionCard>
        );
      })}
      {!isSupportRequest && <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />}
      {isSupportRequest && (
        <div className="pt-2">
          <PurposeTextarea
            value={context}
            onChange={(e) => emit(selections, e.target.value)}
            placeholder={SUPPORT_CONTEXT_PROMPT}
            className="min-h-24"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

export function TextStep({ step, value, answers, onChange }: StepProps) {
  const chips = step.chips ? resolveDyn(step.chips, answers) : [];
  const visibility = value?.visibility ?? "leadership_shared";
  // 3.4 carries an optional dollar figure alongside the written possibility.
  const hasOptionalCurrency = step.key === QK.m3_three_year;
  const seed = (label: string) => {
    const t = value?.text?.trim();
    onChange({ ...value, text: t ? `${t} ${label}` : label, visibility });
  };
  return (
    <div className="mt-6">
      <PurposeTextarea
        value={value?.text ?? ""}
        onChange={(e) => onChange({ ...value, text: e.target.value, visibility })}
        placeholder="Write it in your own words…"
      />
      {hasOptionalCurrency && (
        <div className="relative mt-3 max-w-56">
          <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[var(--purpose-ink-dim)]">
            $
          </span>
          <PurposeInput
            inputMode="numeric"
            value={value?.number != null ? String(value.number) : ""}
            onChange={(e) => {
              const digits = e.target.value.replace(/[^0-9]/g, "");
              onChange({
                ...value,
                visibility,
                number: digits ? Math.min(50_000_000, Number(digits)) : undefined,
              });
            }}
            placeholder="Optional dollar figure"
            className="pl-8 tabular-nums"
            aria-label="Optional dollar figure"
          />
        </div>
      )}
      {step.minChars ? (
        <div className="mt-1.5 text-right text-xs text-[var(--purpose-ink-dim)]">
          {(value?.text ?? "").trim().length} / {step.minChars}+
        </div>
      ) : null}
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <PurposeChip key={c.value} onClick={() => seed(c.label)}>
              {c.label}
            </PurposeChip>
          ))}
        </div>
      )}
      <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />
      <ReflectionPrompts prompts={step.reflectionPrompts ? resolveDyn(step.reflectionPrompts, answers) : undefined} />
      <Examples items={step.examples ? resolveDyn(step.examples, answers) : undefined} />
      {step.visibilityToggle && (
        <VisibilityToggle visibility={visibility} onChange={(v) => onChange({ ...value, visibility: v })} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// currency
// ---------------------------------------------------------------------------

const fmtUsd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function CurrencyStep({ step, value, answers, onChange }: StepProps) {
  const [draft, setDraft] = useState<string>(value?.number != null ? String(value.number) : "");
  const commit = (raw: string) => {
    const digits = raw.replace(/[^0-9.]/g, "");
    if (!digits) return onChange({ ...value, number: undefined });
    // Spec: allow $0 through $1,000,000+ — clamp only at obvious typo scale.
    const n = Math.max(0, Math.min(5_000_000, Math.round(Number(digits))));
    onChange({ ...value, number: Number.isFinite(n) ? n : undefined });
  };
  return (
    <div className="mt-6">
      <div className="relative">
        <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-lg text-[var(--purpose-ink-dim)]">
          $
        </span>
        <PurposeInput
          inputMode="numeric"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => {
            if (value?.number != null) setDraft(String(value.number));
          }}
          placeholder="0"
          className="pl-8 text-lg tabular-nums"
          aria-label="Dollar amount"
        />
      </div>
      {value?.number != null && (
        <div className="mt-2 text-sm text-[var(--purpose-ink-dim)] tabular-nums">{fmtUsd(value.number)}</div>
      )}
      <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// scale (1–10)
// ---------------------------------------------------------------------------

export function ScaleStep({ step, value, answers, onChange }: StepProps) {
  return (
    <div className="mt-6">
      <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={value?.number === n}
            onClick={() => onChange({ ...value, number: n })}
            className={
              "min-h-11 rounded-xl border text-base font-medium tabular-nums transition-colors " +
              (value?.number === n
                ? "border-[var(--purpose-tide)] bg-[color-mix(in_oklab,var(--purpose-tide)_18%,transparent)] text-[var(--purpose-ink)]"
                : "border-[var(--purpose-line)] text-[var(--purpose-ink-dim)] hover:text-[var(--purpose-ink)]")
            }
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-between gap-4 text-xs text-[var(--purpose-ink-dim)]">
        <span>{SCALE_ANCHORS.low}</span>
        <span className="text-right">{SCALE_ANCHORS.high}</span>
      </div>
      <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// dual_text (2.4 fact vs story)
// ---------------------------------------------------------------------------

export function DualTextStep({ value, onChange }: StepProps) {
  const j = asObj(value?.json);
  const fact = (j.fact as string | undefined) ?? "";
  const story = (j.story as string | undefined) ?? "";
  const set = (patch: { fact?: string; story?: string }) =>
    onChange({ json: { fact, story, ...patch } });
  return (
    <div className="mt-6 space-y-6">
      <div>
        <h3 className="text-lg">{FACT_STORY_COPY.factQuestion}</h3>
        <Helper text={FACT_STORY_COPY.factHelper} />
        <PurposeTextarea
          value={fact}
          onChange={(e) => set({ fact: e.target.value })}
          className="mt-3 min-h-24"
          placeholder="Something observable that has happened…"
        />
        <Examples items={FACT_STORY_COPY.factExamples} />
      </div>
      <div>
        <h3 className="text-lg">{FACT_STORY_COPY.storyQuestion}</h3>
        <Helper text={FACT_STORY_COPY.storyHelper} />
        <PurposeTextarea
          value={story}
          onChange={(e) => set({ story: e.target.value })}
          className="mt-3 min-h-24"
          placeholder="The conclusion you've been drawing…"
        />
        <Examples items={FACT_STORY_COPY.storyExamples} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// evidence_date (4.2)
// ---------------------------------------------------------------------------

export function EvidenceDateStep({ step, value, answers, onChange }: StepProps) {
  const j = asObj(value?.json);
  const outcome = (j.outcome as string | undefined) ?? "";
  const date = (j.date as string | undefined) ?? "";
  const set = (patch: { outcome?: string; date?: string }) =>
    onChange({ json: { outcome, date, ...patch } });
  return (
    <div className="mt-6 space-y-5">
      <div>
        <PurposeLabel className="mb-2">What you'll be able to point to</PurposeLabel>
        <PurposeTextarea
          value={outcome}
          onChange={(e) => set({ outcome: e.target.value })}
          className="min-h-24"
          placeholder="A number, milestone, or concrete result…"
        />
      </div>
      <div>
        <PurposeLabel className="mb-2">Target date</PurposeLabel>
        <PurposeInput
          type="date"
          value={date}
          onChange={(e) => set({ date: e.target.value })}
          className="max-w-56 [color-scheme:dark]"
          aria-label="Target date"
        />
      </div>
      <Examples
        items={step.examples ? resolveDyn(step.examples, answers) : undefined}
        label="Milestones that count"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// if_then (5.4)
// ---------------------------------------------------------------------------

export function IfThenStep({ step, value, answers, onChange }: StepProps) {
  const j = asObj(value?.json);
  const prefill = IF_PREFILLS[primaryObstacle(answers)] ?? "";
  const ifText = (j.if as string | undefined) ?? prefill;
  const thenText = (j.then as string | undefined) ?? "";
  const set = (patch: { if?: string; then?: string }) =>
    onChange({ json: { if: ifText, then: thenText, ...patch } });
  return (
    <div className="mt-6 space-y-5">
      <p className="text-base leading-relaxed text-[var(--purpose-ink-dim)]">{ifThenQuestion(answers)}</p>
      <div>
        <PurposeLabel className="mb-2 text-[var(--purpose-sand)]">IF</PurposeLabel>
        <PurposeTextarea
          value={ifText}
          onChange={(e) => set({ if: e.target.value })}
          className="min-h-20"
        />
      </div>
      <div>
        <PurposeLabel className="mb-2 text-[var(--purpose-tide)]">THEN</PurposeLabel>
        <PurposeTextarea
          value={thenText}
          onChange={(e) => set({ then: e.target.value })}
          className="min-h-24"
          placeholder="One small, observable action you will take…"
        />
      </div>
      <Examples items={step.examples ? resolveDyn(step.examples, answers) : undefined} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// why (Seven Levels)
// ---------------------------------------------------------------------------

export function WhyStep({ step, value, answers, onChange }: StepProps) {
  const visibility = value?.visibility ?? "leadership_shared";
  const j = asObj(value?.json);
  const category = (j.category as string | undefined) ?? "";
  const values = Array.isArray(j.values) ? (j.values as string[]) : [];
  const chips = step.chips ? resolveDyn(step.chips, answers) : [];
  const isCoreValues = step.key === "why_6";
  const isCoreWhy = step.key === "why_7";
  // Level 2's chips are the spec's "I don't know" fallback — they only appear
  // when the answer is effectively empty/vague. Other levels' chips are
  // always-available helpers (Level 1's meaning chips, Level 6's values).
  const showChips =
    chips.length > 0 && (step.key !== "why_2" || detectIDontKnow(value?.text ?? ""));

  const emit = (patch: Partial<AnswerValue> & { json?: unknown }) =>
    onChange({
      text: value?.text,
      visibility,
      ...patch,
      json: { ...(category ? { category } : {}), ...(values.length ? { values } : {}), ...asObj(patch.json) },
    });

  const seed = (label: string) => {
    const t = value?.text?.trim();
    emit({ text: t ? `${t} ${label}` : label });
  };

  const toggleValueChip = (v: string) => {
    const next = values.includes(v) ? values.filter((x) => x !== v) : values.length < 3 ? [...values, v] : values;
    onChange({ text: value?.text, visibility, json: { ...(category ? { category } : {}), values: next } });
  };

  return (
    <div className="mt-6">
      {isCoreValues && chips.length > 0 && (
        <div className="mb-4">
          <PurposeLabel className="mb-2">Pick up to three, then put it in a sentence</PurposeLabel>
          <div className="flex flex-wrap gap-2">
            {chips.map((c) => (
              <PurposeChip key={c.value} selected={values.includes(c.value)} onClick={() => toggleValueChip(c.value)}>
                {c.label}
              </PurposeChip>
            ))}
          </div>
        </div>
      )}
      <PurposeTextarea
        value={value?.text ?? ""}
        onChange={(e) => emit({ text: e.target.value })}
        placeholder="Your words, not the right words…"
      />
      {isCoreWhy && (
        <button
          type="button"
          onClick={() => {
            if (!(value?.text ?? "").trim()) emit({ text: CORE_WHY_SCAFFOLD });
          }}
          className="mt-2 text-sm text-[var(--purpose-tide)] hover:underline"
        >
          Use the scaffold
        </button>
      )}
      {!isCoreValues && showChips && (
        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map((c) => (
            <PurposeChip key={c.value} onClick={() => seed(c.label)}>
              {c.label}
            </PurposeChip>
          ))}
        </div>
      )}
      <Helper text={step.helper ? resolveDyn(step.helper, answers) : undefined} />
      {step.visibilityToggle && (
        <VisibilityToggle visibility={visibility} onChange={(v) => emit({ visibility: v })} />
      )}
      {step.privateCategoryOptions && visibility === "private_to_rep" && (
        <div className="mt-4">
          <PurposeLabel className="mb-2">
            Keep the words private — just give Tyler and Shai the category
          </PurposeLabel>
          <div className="flex flex-wrap gap-2">
            {step.privateCategoryOptions.map((o: Option) => (
              <PurposeChip
                key={o.value}
                selected={category === o.value}
                onClick={() =>
                  onChange({ text: value?.text, visibility, json: { ...(values.length ? { values } : {}), category: o.value } })
                }
              >
                {o.label}
              </PurposeChip>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
