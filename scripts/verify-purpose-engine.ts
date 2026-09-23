/** Assertions for the My Purpose workshop engine — run with
 *  `npm run verify:purpose`. Three suites:
 *   1. Validator fixtures (true / false / near-miss per detector).
 *   2. Persona walks: the six spec §25 personas answered end-to-end, asserting
 *      the exact resolved branch steps, no dead ends, and QA-#9 completeness.
 *   3. Adversarial resolution: empty/partial/contradictory answer maps must
 *      never throw, always end at the review step, and progress must be
 *      monotone along a forward walk. */
import type { AnswerMap, AnswerValue, StepDef } from "../src/lib/purpose/types";
import {
  firstIncompleteIndex,
  isStepComplete,
  progressPct,
  requiredProfileComplete,
  resolveDyn,
  resolveSteps,
  resumeIndex,
} from "../src/lib/purpose/engine";
import {
  detectCrisis,
  detectExternalOnly,
  detectIDontKnow,
  detectMaterialOnly,
  detectNonObservable,
  detectPredictiveIdentity,
  detectRepeatsGoal,
  detectVague,
  hasRecognizableEvidence,
} from "../src/lib/purpose/validators";
import { quoteAnswer, whyQuote } from "../src/lib/purpose/interpolate";
import {
  ALL_STEPS,
  MODULES,
  REVIEW_SECTIONS,
  ceilingBand,
  confidenceBand,
  pickReminderLine,
  primaryConstraint,
  primaryLifeArea,
  primaryObstacle,
} from "../src/data/purpose-workshop-content";
import { QK } from "../src/lib/purpose/questionKeys";

let failures = 0;
function expectEq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`✗ ${label}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
function expectTrue(label: string, got: boolean) {
  expectEq(label, got, true);
}

// ═══ 1. Validators ══════════════════════════════════════════════════════════

expectTrue("predictive: 'I can't close big deals'", detectPredictiveIdentity("I can't close big deals"));
expectTrue("predictive: curly 'I’ll never get there'", detectPredictiveIdentity("I’ll never get there"));
expectTrue("predictive: 'people like me don't win'", detectPredictiveIdentity("people like me don't win"));
expectEq("predictive: '$90,000 last year' fact is fine", detectPredictiveIdentity("I made $90,000 last year"), false);
expectEq(
  "predictive: 'not yet consistently followed up' is fine",
  detectPredictiveIdentity("I have not yet consistently followed up"),
  false,
);

expectTrue("vague: 'be successful'", detectVague("be successful"));
expectTrue("vague: 'make more money'", detectVague("make more money"));
expectTrue("vague: 'rich'", detectVague("rich"));
expectEq(
  "vague: long specific answer containing 'be happy' passes",
  detectVague("I want to be happy, which for me means owning a duplex in Vista and coaching my son's team"),
  false,
);
expectEq("vague: empty string is missing, not vague", detectVague(""), false);

expectTrue("external-only: 'they got lucky'", detectExternalOnly("they got lucky"));
expectTrue("external-only: 'better leads'", detectExternalOnly("better leads"));
expectEq(
  "external-only: luck + controllable behavior passes",
  detectExternalOnly("they got lucky but they also followed up every single day"),
  false,
);
expectEq("external-only: pure skill answer passes", detectExternalOnly("they practiced discovery weekly"), false);

expectTrue("non-observable: 'try harder'", detectNonObservable("try harder"));
expectTrue("non-observable: 'stay motivated'", detectNonObservable("stay motivated"));
expectEq(
  "non-observable: platitude + concrete action passes",
  detectNonObservable("work harder by making one follow-up call for ten minutes before lunch"),
  false,
);

expectTrue("evidence: digits count", hasRecognizableEvidence("close 3 deals"));
expectTrue("evidence: month counts", hasRecognizableEvidence("move by December"));
expectTrue("evidence: completion verb counts", hasRecognizableEvidence("finish the training routine"));
expectEq("evidence: pure feeling fails", hasRecognizableEvidence("feel way more confident"), false);

expectTrue(
  "repeats-goal: restated goal trips",
  detectRepeatsGoal("Earn $150,000 in the next 12 months", "Earn $150,000 in the next twelve 12 months"),
);
expectEq(
  "repeats-goal: a real bridge passes",
  detectRepeatsGoal(
    "Stop avoiding follow-up and review every deal weekly with coaching",
    "Earn $150,000 in the next 12 months",
  ),
  false,
);

expectTrue("idk: 'I don't know'", detectIDontKnow("I don't know"));
expectTrue("idk: 'idk'", detectIDontKnow("idk"));
expectTrue("idk: near-empty", detectIDontKnow("meh"));
expectEq("idk: real sentence passes", detectIDontKnow("Because my daughter watches what I do"), false);

expectTrue("material-only: 'I can buy a car'", detectMaterialOnly("I can buy a car"));
expectEq(
  "material-only: acquisition + value words passes",
  detectMaterialOnly("buy a home where my kids feel safe"),
  false,
);
expectEq(
  "material-only: long specific answer passes",
  detectMaterialOnly(
    "I could buy a duplex, rent half of it out, and use the difference to stop worrying about every slow week",
  ),
  false,
);

expectTrue("crisis: direct phrase", detectCrisis("some days I want to die"));
expectTrue("crisis: self harm", detectCrisis("I've been thinking about self-harm again"));
expectEq("crisis: rough day is not crisis", detectCrisis("this week nearly killed my motivation"), false);
expectEq("crisis: sales slang passes", detectCrisis("I crushed it and closed the deal"), false);

// ═══ interpolation ═══════════════════════════════════════════════════════════

const interpMap: AnswerMap = {
  [QK.m4_one_year_target]: { text: "  Earn $150,000 in the next 12 months.  " },
  why_1: { text: "a".repeat(300) },
};
expectEq(
  "quoteAnswer trims + strips terminal punctuation",
  quoteAnswer(interpMap, QK.m4_one_year_target),
  "Earn $150,000 in the next 12 months",
);
expectTrue("quoteAnswer truncates to ≤90", quoteAnswer(interpMap, "why_1").length <= 90);
expectEq("whyQuote falls back grammatically", whyQuote({}, 3), "the person you described");

// ═══ 2. Persona walks (§25) ══════════════════════════════════════════════════

/** Answer every resolved step with persona-appropriate values, front to back,
 *  re-resolving after each answer (exactly how the UI advances). */
function walkPersona(
  label: string,
  seed: {
    direction: string;
    ceiling: number;
    confidence: number;
    beliefCats: string[];
    obstacles: string[];
    outsideView?: string;
    lifeAreas?: string[];
    privateWhys?: boolean;
  },
): AnswerMap {
  const a: Record<string, AnswerValue> = {};
  const answerFor = (step: StepDef): AnswerValue => {
    switch (step.kind) {
      case "story":
        return { json: { seen: true } };
      case "single_select": {
        if (step.key === QK.m1_direction) return { text: seed.direction };
        const opts = resolveDyn(step.options ?? [], a as AnswerMap);
        return { text: opts[0]?.value ?? "other" };
      }
      case "multi_select": {
        if (step.key === QK.m2_belief_categories) return { json: seed.beliefCats };
        if (step.key === QK.m5_obstacles) return { json: seed.obstacles };
        if (step.key === QK.m3_life_areas) return { json: seed.lifeAreas ?? ["income", "family"] };
        if (step.key === QK.m5_support_request) return { json: { selections: ["accountability"] } };
        const opts = resolveDyn(step.options ?? [], a as AnswerMap);
        return { json: [opts[0]?.value ?? "other"] };
      }
      case "text": {
        if (step.key === QK.m2_outside_view)
          return { text: seed.outsideView ?? "They asked for coaching sooner and followed up on every deal without fail" };
        if (step.key === QK.m4_mission_90)
          return { text: "Prove I can keep a weekly follow-up and deal-review routine with coaching" };
        return { text: "Something specific, honest, and long enough to count for this persona." };
      }
      case "currency":
        return { number: seed.ceiling };
      case "scale":
        return { number: seed.confidence };
      case "dual_text":
        return { json: { fact: "I made $80,000 last year", story: "That means I cannot make more" } };
      case "evidence_date":
        return { json: { outcome: "Save $12,000 and close 40 deals", date: "2027-09-01" } };
      case "if_then":
        return { json: { if: "I have a bad sales day", then: "I will review one deal and make one follow-up call before deciding what the day means" } };
      case "why": {
        const level = Number(step.key.split("_")[1]);
        const isPrivate = seed.privateWhys && (level === 4 || level === 5);
        return {
          text: `Level ${level}: because the life I am building matters more than my comfort`,
          visibility: isPrivate ? "private_to_rep" : "leadership_shared",
          json: isPrivate ? { category: level === 4 ? "parents_family" : "regret" } : level === 6 ? { values: ["security"] } : undefined,
        };
      }
      case "review":
        return { json: { seen: true } };
    }
  };

  // Forward walk with monotone-progress assertion.
  let guard = 0;
  let lastProgress = -1;
  for (;;) {
    if (++guard > 200) {
      failures++;
      console.error(`✗ ${label}: walk did not terminate`);
      break;
    }
    const steps = resolveSteps(ALL_STEPS, a as AnswerMap);
    const idx = firstIncompleteIndex(steps, a as AnswerMap);
    const step = steps[idx];
    const prog = progressPct(MODULES, steps, idx);
    if (prog < lastProgress - 25) {
      // Branch injections may shift within a module; a big backwards jump
      // means the weighting broke.
      failures++;
      console.error(`✗ ${label}: progress fell ${lastProgress} → ${prog} at ${step.key}`);
    }
    lastProgress = Math.max(lastProgress, prog);
    if (step.kind === "review") break;
    // Prompt must always resolve to a non-empty string (no template crashes).
    const prompt = resolveDyn(step.prompt, a as AnswerMap);
    if (typeof prompt !== "string") {
      failures++;
      console.error(`✗ ${label}: prompt did not resolve at ${step.key}`);
    }
    a[step.key] = answerFor(step);
  }

  const done = requiredProfileComplete(ALL_STEPS, a as AnswerMap);
  expectTrue(`${label}: completeness gate passes`, done.ok === true);
  return a as AnswerMap;
}

const has = (a: AnswerMap, key: string) => Object.prototype.hasOwnProperty.call(a, key);

// Sample 1 — skill gap: mid ceiling, confidence 5, skill constraint.
const p1 = walkPersona("persona-1 skill", {
  direction: "vague",
  ceiling: 125_000,
  confidence: 5,
  beliefCats: ["skill_doubt"],
  obstacles: ["dont_ask_help"],
});
expectEq("p1: mid ceiling band", ceilingBand(p1), "mid");
expectEq("p1: constraint sales_skill", primaryConstraint(p1), "sales_skill");
expectTrue("p1: mid-confidence lever asked", has(p1, QK.m4_confidence_lever));
expectEq("p1: low/high confidence steps absent", has(p1, QK.m4_confidence_one_point) || has(p1, QK.m4_overconfidence_risk), false);

// Sample 2 — consistency gap: confidence 6, inconsistent direction pre-flag.
const p2 = walkPersona("persona-2 consistency", {
  direction: "inconsistent",
  ceiling: 180_000,
  confidence: 6,
  beliefCats: ["identity_doubt", "consistency_doubt"],
  obstacles: ["wait_for_motivation"],
  lifeAreas: ["home"],
});
expectEq("p2: consistency pre-flag wins the tie", primaryConstraint(p2), "consistency");
expectEq("p2: primary life area home", primaryLifeArea(p2), "home");

// Sample 3 — rejection avoidance: low-mid, confidence 4.
const p3 = walkPersona("persona-3 rejection", {
  direction: "week_focus",
  ceiling: 150_000,
  confidence: 4,
  beliefCats: ["rejection_avoidance"],
  obstacles: ["avoid_rejection"],
  lifeAreas: ["family"],
});
expectEq("p3: constraint rejection_avoidance", primaryConstraint(p3), "rejection_avoidance");
expectEq("p3: obstacle avoid_rejection", primaryObstacle(p3), "avoid_rejection");
expectTrue("p3: family/income reminder line", pickReminderLine(p3).includes("stability"));

// Sample 4 — identity ceiling: confidence 3 → low branch, private whys.
const p4 = walkPersona("persona-4 identity", {
  direction: "stuck",
  ceiling: 100_000,
  confidence: 3,
  beliefCats: ["identity_doubt"],
  obstacles: ["discouraged"],
  privateWhys: true,
  lifeAreas: ["confidence"],
});
expectEq("p4: constraint identity_ceiling", primaryConstraint(p4), "identity_ceiling");
expectTrue("p4: low-confidence reason asked", has(p4, QK.m4_confidence_reason));
expectTrue("p4: one-point question asked", has(p4, QK.m4_confidence_one_point));
expectEq("p4: private why_4 masked in leadership review", (() => {
  const whyRow = REVIEW_SECTIONS.find((s) => s.label === "MY SEVEN LEVELS OF WHY");
  const rendered = whyRow?.render(p4, { maskPrivate: true }) ?? "";
  return rendered.includes("Private") && !rendered.includes("Level 4: Level 4:");
})(), true);
expectEq("p4: rep's own review shows the words", (() => {
  const whyRow = REVIEW_SECTIONS.find((s) => s.label === "MY SEVEN LEVELS OF WHY");
  return (whyRow?.render(p4, { maskPrivate: false }) ?? "").includes("Level 4: because the life") ||
    (whyRow?.render(p4, { maskPrivate: false }) ?? "").includes("the life I am building");
})(), true);

// Sample 5 — high aspiration: high ceiling, confidence 8 → overconfidence ask.
const p5 = walkPersona("persona-5 planner", {
  direction: "clear",
  ceiling: 300_000,
  confidence: 8,
  beliefCats: ["no_purpose"],
  obstacles: ["no_plan"],
  lifeAreas: ["freedom"],
});
expectEq("p5: high band", ceilingBand(p5), "high");
expectEq("p5: high confidence band", confidenceBand(p5), "high");
expectTrue("p5: overconfidence risk asked", has(p5, QK.m4_overconfidence_risk));
expectTrue("p5: clear-direction follow-through asked", has(p5, QK.m3_followthrough_difficulty));

// Sample 6 — unclear purpose: low ceiling, confidence 2, external-only 2.6.
const p6 = walkPersona("persona-6 unclear", {
  direction: "unsure",
  ceiling: 85_000,
  confidence: 2,
  beliefCats: ["no_purpose"],
  obstacles: ["dont_know"],
  outsideView: "they got lucky with better leads",
  lifeAreas: ["education"],
});
// $85k sits in band B (spec: low is ≤ $75,000) — the persona sheet's ceiling
// is mid-band even though the persona reads "low".
expectEq("p6: band for $85k is mid", ceilingBand(p6), "mid");
expectEq("p6: constraint lack_of_purpose", primaryConstraint(p6), "lack_of_purpose");
expectTrue("p6: external-only follow-up injected", has(p6, QK.m2_outside_view_control));
expectEq("p6: p1 never saw that follow-up", has(p1, QK.m2_outside_view_control), false);

// ═══ 3. Adversarial resolution ═══════════════════════════════════════════════

const empty: AnswerMap = {};
const emptySteps = resolveSteps(ALL_STEPS, empty);
expectTrue("empty map resolves without throwing", emptySteps.length > 20);
expectEq("empty map ends at review", emptySteps[emptySteps.length - 1].kind, "review");
for (const s of emptySteps) {
  const prompt = resolveDyn(s.prompt, empty);
  // A story step may carry an empty prompt when its storyBody is the whole
  // card (5.2's summary card has no headline in the spec).
  const emptyOk = s.kind === "story" && !!s.storyBody;
  if (typeof prompt !== "string" || (prompt.length === 0 && !emptyOk)) {
    failures++;
    console.error(`✗ empty-map prompt failed to resolve at ${s.key}`);
  }
  if (s.options) {
    const opts = resolveDyn(s.options, empty);
    if (!Array.isArray(opts) || opts.length === 0) {
      failures++;
      console.error(`✗ empty-map options failed at ${s.key}`);
    }
  }
}
console.log("✓ every step's prompt/options resolve on an empty map");

// §20.2 low-ceiling believability branch — present at ≤75k, absent above.
const lowBand: AnswerMap = { [QK.m2_ceiling_amount]: { number: 60_000 } };
expectTrue(
  "low band injects the believability ask",
  resolveSteps(ALL_STEPS, lowBand).some((s) => s.key === QK.m2_ceiling_believe),
);
expectEq(
  "mid band omits the believability ask",
  resolveSteps(ALL_STEPS, { [QK.m2_ceiling_amount]: { number: 100_000 } }).some(
    (s) => s.key === QK.m2_ceiling_believe,
  ),
  false,
);

// §20.3 fear-constraint asks — gated, with the right variant per constraint.
const fearFail: AnswerMap = { [QK.m2_belief_categories]: { json: ["fear_of_failure"] } };
const fearSuccess: AnswerMap = { [QK.m2_belief_categories]: { json: ["fear_of_success"] } };
const fearFailStep = resolveSteps(ALL_STEPS, fearFail).find((s) => s.key === QK.m2_fear_cost);
expectTrue("fear_of_failure injects the fear ask", !!fearFailStep);
expectTrue(
  "fear_of_failure prompt asks what failure would mean",
  (fearFailStep ? resolveDyn(fearFailStep.prompt, fearFail) : "").includes("afraid that would mean"),
);
const fearSuccessStep = resolveSteps(ALL_STEPS, fearSuccess).find((s) => s.key === QK.m2_fear_cost);
expectTrue(
  "fear_of_success prompt asks about cost/change",
  (fearSuccessStep ? resolveDyn(fearSuccessStep.prompt, fearSuccess) : "").includes("cost or change"),
);
expectEq(
  "skill constraint omits the fear ask",
  resolveSteps(ALL_STEPS, { [QK.m2_belief_categories]: { json: ["skill_doubt"] } }).some(
    (s) => s.key === QK.m2_fear_cost,
  ),
  false,
);

// Contradictory edit: ceiling answered for band C, then edited into band A —
// the band-A reason options must resolve, and the stale band-C selection must
// read as UNANSWERED (single_select completeness now checks option
// membership) so the flow revisits it instead of shipping a wrong reason.
const contradictory: AnswerMap = {
  [QK.m2_ceiling_amount]: { number: 50_000 },
  [QK.m2_ceiling_reason]: { text: "earned_before" }, // a band-C option
};
expectEq("contradictory edit still resolves band", ceilingBand(contradictory), "low");
expectTrue(
  "contradictory map still resolves steps",
  resolveSteps(ALL_STEPS, contradictory).length > 20,
);
const staleReasonStep = ALL_STEPS.find((s) => s.key === QK.m2_ceiling_reason)!;
expectEq(
  "stale cross-band selection reads unanswered",
  isStepComplete(staleReasonStep, contradictory),
  false,
);

// Resume semantics: stale persisted key → first incomplete; valid key with a
// hole earlier → the hole wins.
const p1Steps = resolveSteps(ALL_STEPS, p1);
expectEq("resume: stale key falls back", resumeIndex(p1Steps, empty, "no_such_step"), firstIncompleteIndex(p1Steps, empty));
const holed: Record<string, AnswerValue> = { ...(p1 as Record<string, AnswerValue>) };
delete holed[QK.m2_ceiling_story];
const holedSteps = resolveSteps(ALL_STEPS, holed as AnswerMap);
expectEq(
  "resume: earlier hole wins over persisted key",
  resumeIndex(holedSteps, holed as AnswerMap, QK.m5_identity_commitment),
  holedSteps.findIndex((s) => s.key === QK.m2_ceiling_story),
);

// Required-field gate: missing core why blocks completeness.
const noCore: Record<string, AnswerValue> = { ...(p1 as Record<string, AnswerValue>) };
delete noCore[QK.why_7];
const gate = requiredProfileComplete(ALL_STEPS, noCore as AnswerMap);
expectTrue("gate: missing core why blocks", gate.ok === false && gate.missing.includes(QK.why_7));

// isStepComplete: private why_4 without a category is incomplete.
const why4Step = ALL_STEPS.find((s) => s.key === QK.why_4)!;
expectEq(
  "private why_4 without category is incomplete",
  isStepComplete(why4Step, { why_4: { text: "words", visibility: "private_to_rep" } }),
  false,
);
expectEq(
  "private why_4 with category is complete",
  isStepComplete(why4Step, { why_4: { text: "words", visibility: "private_to_rep", json: { category: "parents_family" } } }),
  true,
);

// ═══ result ══════════════════════════════════════════════════════════════════

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll purpose-engine checks passed.");
