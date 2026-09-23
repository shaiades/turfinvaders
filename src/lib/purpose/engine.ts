// My Purpose — the pure workshop engine. No React, no supabase: everything
// here is a function of (step definitions, answers), which is what lets
// scripts/verify-purpose-engine.ts walk whole personas through the flow
// before any UI exists. Branching is filter-style: the resolved list is
// always a subsequence of the one canonical ALL_STEPS order, so it can never
// dead-end — it just ends at the review step.

import type { AnswerMap, AnswerValue, ModuleKey, ModuleMeta, StepDef } from "./types";

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const nonEmpty = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** Selections for a multi_select answer — tolerates both raw arrays and the
 *  {selections: []} composite used by the support-request step. */
export function selectionsOf(v: AnswerValue | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v.json)) return v.json.filter((x): x is string => typeof x === "string");
  const sel = asObj(v.json).selections;
  if (Array.isArray(sel)) return sel.filter((x): x is string => typeof x === "string");
  return [];
}

export function resolveDyn<T>(dyn: T | ((a: AnswerMap) => T), a: AnswerMap): T {
  return typeof dyn === "function" ? (dyn as (a: AnswerMap) => T)(a) : dyn;
}

/** The steps that exist for THIS answer map, in canonical order. */
export function resolveSteps(all: readonly StepDef[], a: AnswerMap): StepDef[] {
  return all.filter((s) => !s.when || s.when(a));
}

/** Kind-aware "has a usable answer" check, plus the step's own block-level
 *  validation. Coach-level issues do NOT make a step incomplete — the shell
 *  surfaces them but an edited answer may proceed. */
export function isStepComplete(step: StepDef, a: AnswerMap): boolean {
  const v = a[step.key];
  let answered = false;
  switch (step.kind) {
    case "story":
      answered = asObj(v?.json).seen === true;
      break;
    case "single_select": {
      answered = nonEmpty(v?.text);
      // A selection must belong to the CURRENTLY resolved option list — an
      // edit that moves the ceiling across a band boundary leaves the old
      // band's reason slug behind, and that stale pick must read as
      // unanswered so the flow (and edit-mode chaining) revisits it.
      if (answered && step.options) {
        const opts = resolveDyn(step.options, a);
        answered = opts.some((o) => o.value === v?.text);
      }
      break;
    }
    case "multi_select":
      answered = selectionsOf(v).length > 0;
      break;
    case "text": {
      answered = nonEmpty(v?.text);
      if (answered && step.minChars) answered = (v?.text ?? "").trim().length >= step.minChars;
      break;
    }
    case "currency":
    case "scale":
      answered = typeof v?.number === "number" && Number.isFinite(v.number);
      break;
    case "dual_text": {
      const j = asObj(v?.json);
      answered = nonEmpty(j.fact) && nonEmpty(j.story);
      break;
    }
    case "evidence_date": {
      const j = asObj(v?.json);
      answered = nonEmpty(j.outcome) && nonEmpty(j.date);
      break;
    }
    case "if_then": {
      const j = asObj(v?.json);
      answered = nonEmpty(j.if) && nonEmpty(j.then);
      break;
    }
    case "why": {
      answered = nonEmpty(v?.text);
      // A private level 4/5 answer must still give leadership its high-level
      // category (spec §16) — without it the step isn't done.
      if (
        answered &&
        step.privateCategoryOptions &&
        v?.visibility === "private_to_rep" &&
        !nonEmpty(asObj(v?.json).category)
      ) {
        answered = false;
      }
      break;
    }
    case "review":
      // The review screen's gate is the submit action itself.
      answered = true;
      break;
  }
  // Optional steps pass while blank — but once ANSWERED they still face
  // block-level validation, same as required ones (a future validator on an
  // optional step must not silently stop blocking).
  if (!step.required && step.kind !== "story" && !answered) return true;
  if (!answered) return false;
  const issue = step.validate?.(v, a);
  return issue?.level !== "block";
}

export function firstIncompleteIndex(steps: readonly StepDef[], a: AnswerMap): number {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if ((s.required || s.kind === "story") && !isStepComplete(s, a)) return i;
  }
  return Math.max(0, steps.length - 1);
}

/** Where to land on resume. `persistedStepKey` is a step KEY (indices shift
 *  when branches change; keys don't). A stale key, or any incomplete required
 *  step earlier in the flow, falls back to the first incomplete step. */
export function resumeIndex(
  steps: readonly StepDef[],
  a: AnswerMap,
  persistedStepKey: string | null | undefined,
): number {
  const fallback = firstIncompleteIndex(steps, a);
  if (!persistedStepKey) return fallback;
  const idx = steps.findIndex((s) => s.key === persistedStepKey);
  if (idx === -1) return fallback;
  for (let i = 0; i < idx; i++) {
    const s = steps[i];
    if ((s.required || s.kind === "story") && !isStepComplete(s, a)) return i;
  }
  return Math.min(idx, steps.length - 1);
}

/** Module-weighted progress: passed modules contribute their full weight,
 *  the current module contributes proportionally to position within it. A
 *  branch-injected follow-up only re-scales inside its module's band, so the
 *  bar never jumps across module boundaries. Callers that want a monotone
 *  DISPLAY should clamp to max-so-far themselves (and reset the clamp on an
 *  explicit Back). */
export function progressPct(
  modules: readonly ModuleMeta[],
  steps: readonly StepDef[],
  index: number,
): number {
  if (steps.length === 0) return 0;
  const clamped = Math.max(0, Math.min(index, steps.length - 1));
  const currentModule = steps[clamped].module;
  let pct = 0;
  for (const m of modules) {
    if (m.key === currentModule) break;
    pct += m.weight;
  }
  const inModule = steps.filter((s) => s.module === currentModule);
  const pos = steps.slice(0, clamped + 1).filter((s) => s.module === currentModule).length - 1;
  const weight = modules.find((m) => m.key === currentModule)?.weight ?? 0;
  if (inModule.length > 0) pct += (weight * pos) / inModule.length;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export function moduleMetaFor(
  modules: readonly ModuleMeta[],
  key: ModuleKey,
): ModuleMeta | undefined {
  return modules.find((m) => m.key === key);
}

/** QA gate #9 — the answers every complete profile must contain, checked
 *  client-side before enabling "Save My Purpose" (the submit RPC re-checks
 *  server-side as the backstop). Returns the missing step keys. */
export function requiredProfileComplete(
  all: readonly StepDef[],
  a: AnswerMap,
): { ok: true } | { ok: false; missing: string[] } {
  const steps = resolveSteps(all, a);
  const missing = steps
    .filter((s) => (s.required || s.kind === "story") && s.kind !== "review" && !isStepComplete(s, a))
    .map((s) => s.key);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}
