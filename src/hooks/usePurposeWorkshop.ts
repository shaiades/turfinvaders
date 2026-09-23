// My Purpose — the workshop state machine. One hook owns: the merged local
// AnswerMap (server + on-device draft), the SaveQueue, step
// resolution/position, per-step validation gating (block vs coach), the
// crisis interruption, and edit-after-submit chaining.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AnswerMap, AnswerValue, StepDef, StepIssue } from "@/lib/purpose/types";
import {
  firstIncompleteIndex,
  isStepComplete,
  progressPct,
  resolveSteps,
  resumeIndex,
} from "@/lib/purpose/engine";
import {
  SaveQueue,
  clearDraft,
  mergeAnswers,
  readDraft,
  writeDraft,
  type SaveState,
} from "@/lib/purpose/autosave";
import { detectCrisis } from "@/lib/purpose/validators";
import { ALL_STEPS, MODULES } from "@/data/purpose-workshop-content";
import { buildSaveAnswer, purposeAnswersKey, usePurposeAnswers } from "./usePurposeAnswers";
import { savePurposePosition } from "./usePurposeProfile";
import { purposeTable, type PurposeProfileRow } from "./usePurposeTable";

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** All human text inside an answer, for crisis scanning. */
function answerTexts(v: AnswerValue): string {
  const parts: string[] = [];
  if (v.text) parts.push(v.text);
  const j = asObj(v.json);
  for (const field of ["fact", "story", "if", "then", "outcome", "context", "text"]) {
    const s = j[field];
    if (typeof s === "string") parts.push(s);
  }
  return parts.join("\n");
}

export type WorkshopMode = { kind: "flow" } | { kind: "edit"; stepKey: string; onDone: () => void };

export function usePurposeWorkshop(profile: PurposeProfileRow, mode: WorkshopMode) {
  const qc = useQueryClient();
  const answersQuery = usePurposeAnswers(profile.id);

  const [answers, setAnswers] = useState<Record<string, AnswerValue> | null>(null);
  const answersRef = useRef<Record<string, AnswerValue>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [index, setIndex] = useState(0);
  const [issue, setIssue] = useState<StepIssue | null>(null);
  const [crisis, setCrisis] = useState(false);
  // Coach-tier escape hatch: the first Continue shows the callout; any edit
  // to the answer afterwards arms the next Continue even if the heuristic
  // still fires (false positives must never trap anyone).
  const coachArmRef = useRef<{ key: string; snapshot: string } | null>(null);
  const maxProgressRef = useRef(0);
  const initializedRef = useRef(false);

  const queueRef = useRef<SaveQueue | null>(null);
  if (!queueRef.current) {
    queueRef.current = new SaveQueue({
      save: buildSaveAnswer(
        { id: profile.id, user_id: profile.user_id },
        () => answersRef.current as AnswerMap,
      ),
      onState: setSaveState,
    });
  }

  // --- Initialization: server answers + on-device draft, newest per key ---
  useEffect(() => {
    if (initializedRef.current || !answersQuery.data) return;
    initializedRef.current = true;
    const { merged, unsynced } = mergeAnswers(answersQuery.data, readDraft(profile.user_id));
    answersRef.current = merged;
    setAnswers(merged);
    const steps = resolveSteps(ALL_STEPS, merged as AnswerMap);
    if (mode.kind === "edit") {
      const i = steps.findIndex((s) => s.key === mode.stepKey);
      setIndex(i === -1 ? firstIncompleteIndex(steps, merged as AnswerMap) : i);
    } else {
      setIndex(resumeIndex(steps, merged as AnswerMap, profile.current_step));
    }
    // Draft entries the server never saw go straight back into the queue.
    const q = queueRef.current!;
    for (const key of unsynced) {
      const step = ALL_STEPS.find((s) => s.key === key);
      if (step) q.enqueue(key, merged[key], { module: step.module, stepKey: key });
    }
    if (unsynced.length > 0) void q.flushAll();
  }, [answersQuery.data, mode, profile.current_step, profile.user_id]);

  // --- Flush on tab-hide / page-unload (best effort, GratitudeGate style) ---
  useEffect(() => {
    const flush = () => void queueRef.current?.flushAll();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  useEffect(() => () => queueRef.current?.dispose(), []);

  const steps = useMemo(
    () => resolveSteps(ALL_STEPS, (answers ?? {}) as AnswerMap),
    [answers],
  );
  const clampedIndex = Math.max(0, Math.min(index, Math.max(0, steps.length - 1)));
  const step: StepDef | undefined = steps[clampedIndex];

  const rawProgress = progressPct(MODULES, steps, clampedIndex);
  // Monotone display: a branch-injected follow-up pauses the bar, never
  // rewinds it. An explicit Back resets the clamp (the bar must not lie).
  if (rawProgress > maxProgressRef.current) maxProgressRef.current = rawProgress;
  const progress = maxProgressRef.current;

  // --- Crisis flag: discreet, metadata-only, once per profile per device ---
  const raiseSafetyFlag = useCallback(
    (questionKey: string, moduleKey: string) => {
      const guard = `ti_purpose_crisis_flagged:${profile.id}`;
      try {
        if (localStorage.getItem(guard)) return;
        localStorage.setItem(guard, new Date().toISOString());
      } catch {
        /* still attempt the insert */
      }
      // Fire-and-forget: a network failure must never suppress the on-screen
      // support card, and the flag carries NO answer text by design.
      void purposeTable("purpose_safety_flags")
        .insert({
          purpose_profile_id: profile.id,
          user_id: profile.user_id,
          question_key: questionKey,
          module_key: moduleKey,
        })
        .then(() => undefined);
    },
    [profile.id, profile.user_id],
  );

  const setAnswer = useCallback(
    (key: string, value: AnswerValue) => {
      const stamped: AnswerValue = { ...value, updatedAt: new Date().toISOString() };
      const next = { ...answersRef.current, [key]: stamped };
      answersRef.current = next;
      setAnswers(next);
      writeDraft(profile.user_id, next);
      const stepDef = ALL_STEPS.find((s) => s.key === key);
      queueRef.current!.enqueue(key, stamped, {
        module: stepDef?.module ?? "clear_board",
        stepKey: key,
      });
      if (issue) setIssue(null);
      const text = answerTexts(stamped);
      if (text && detectCrisis(text)) {
        setCrisis(true);
        raiseSafetyFlag(key, stepDef?.module ?? "clear_board");
      }
    },
    [issue, profile.user_id, raiseSafetyFlag],
  );

  /** Continue. Returns true when the flow advanced (or finished, in edit
   *  mode); false when validation held the step. */
  const goNext = useCallback((): boolean => {
    if (!step) return false;
    const a = answersRef.current as AnswerMap;
    const v = a[step.key];

    // Stories complete themselves on Continue.
    if (step.kind === "story" && asObj(v?.json).seen !== true) {
      setAnswer(step.key, { json: { seen: true } });
    }

    const currentSnapshot = JSON.stringify(answersRef.current[step.key] ?? null);
    const validation = step.validate?.(answersRef.current[step.key], answersRef.current as AnswerMap) ?? null;

    if (step.kind !== "story" && (step.required || isAnswered(step, answersRef.current as AnswerMap))) {
      if (!isStepComplete(step, answersRef.current as AnswerMap)) {
        // Either genuinely unanswered or a block-tier validation failure.
        setIssue(
          validation?.level === "block"
            ? validation
            : { level: "block", message: "Answer this one before continuing — it anchors what comes next." },
        );
        return false;
      }
      if (validation?.level === "coach") {
        const arm = coachArmRef.current;
        if (!(arm && arm.key === step.key && arm.snapshot !== currentSnapshot)) {
          coachArmRef.current = { key: step.key, snapshot: currentSnapshot };
          setIssue(validation);
          return false;
        }
      }
    }

    setIssue(null);
    coachArmRef.current = null;
    void queueRef.current!.flushAll();

    const freshSteps = resolveSteps(ALL_STEPS, answersRef.current as AnswerMap);

    if (mode.kind === "edit") {
      // Re-branch chaining: an edit can inject a newly-required follow-up
      // (ceiling band change, confidence band change). Visit those before
      // handing control back to the review.
      const editedIdx = freshSteps.findIndex((s) => s.key === step.key);
      const nextIncomplete = freshSteps.findIndex(
        (s, i) =>
          i > editedIdx && (s.required || s.kind === "story") && s.kind !== "review" && !isStepComplete(s, answersRef.current as AnswerMap),
      );
      if (nextIncomplete !== -1) {
        setIndex(nextIncomplete);
        return true;
      }
      mode.onDone();
      return true;
    }

    const currentIdx = freshSteps.findIndex((s) => s.key === step.key);
    const nextIdx = Math.min((currentIdx === -1 ? clampedIndex : currentIdx) + 1, freshSteps.length - 1);
    setIndex(nextIdx);
    const nextStep = freshSteps[nextIdx];
    if (nextStep && profile.status === "in_progress") {
      void savePurposePosition(profile.user_id, nextStep.module, nextStep.key).catch(() => undefined);
    }
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    return true;
  }, [clampedIndex, mode, profile.status, profile.user_id, setAnswer, step]);

  const goBack = useCallback(() => {
    setIssue(null);
    coachArmRef.current = null;
    const prev = Math.max(0, clampedIndex - 1);
    setIndex(prev);
    // Back is deliberate — recompute the display clamp so the bar stays honest.
    maxProgressRef.current = progressPct(MODULES, steps, prev);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [clampedIndex, steps]);

  const jumpToStep = useCallback(
    (key: string) => {
      const i = steps.findIndex((s) => s.key === key);
      if (i !== -1) {
        setIssue(null);
        coachArmRef.current = null;
        setIndex(i);
      }
    },
    [steps],
  );

  /** Save-and-continue-later: drain the queue, keep the draft mirror. */
  const saveAndExit = useCallback(async () => {
    await queueRef.current!.flushAll();
  }, []);

  /** After a successful submit RPC the server is canonical — drop the local
   *  draft and refetch the composed answers. */
  const onSubmitted = useCallback(() => {
    clearDraft(profile.user_id);
    qc.invalidateQueries({ queryKey: purposeAnswersKey(profile.id) });
  }, [profile.id, profile.user_id, qc]);

  return {
    loading: !answers,
    answers: (answers ?? {}) as AnswerMap,
    steps,
    index: clampedIndex,
    step,
    progress,
    saveState,
    lastSaveError: () => queueRef.current!.lastError,
    retrySave: () => queueRef.current!.retryNow(),
    hasDirty: () => queueRef.current!.hasDirty(),
    flush: () => queueRef.current!.flushAll(),
    issue,
    clearIssue: () => setIssue(null),
    crisis,
    dismissCrisis: () => setCrisis(false),
    setAnswer,
    goNext,
    goBack,
    jumpToStep,
    saveAndExit,
    onSubmitted,
  };
}

/** Optional steps only gate on validation when the user actually answered. */
function isAnswered(step: StepDef, a: AnswerMap): boolean {
  const v = a[step.key];
  if (!v) return false;
  if (v.text?.trim()) return true;
  if (typeof v.number === "number") return true;
  if (v.date) return true;
  if (v.json !== undefined && v.json !== null) {
    if (Array.isArray(v.json)) return v.json.length > 0;
    const o = asObj(v.json);
    return Object.values(o).some((x) => (typeof x === "string" ? x.trim() : x));
  }
  return false;
}
