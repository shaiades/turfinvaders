// Door script — Shai's real canvass script, WORD FOR WORD (owner, 2026-10-15).
// Single source of truth: the Active Run script stepper and the rebuttal cards
// render THIS file; components never hard-code script copy. Shai edits wording
// here without touching components.
//
//   SCRIPT_STEPS  verbatim — do not touch a word without Shai.
//   REBUTTALS     Empathy → Clarification → Realignment, every one ending in
//                 a two-option question, ≤3 short sunlight-readable lines —
//                 approved by Shai 2026-10-16.
//
// The INFO step is also the lead form's field order. The form itself is a
// Monday WorkForms iframe (src/lib/monday-form.ts), so the order is set in
// Monday's form builder, not here — see LEAD_FORM_FIELD_ORDER below for what
// to set it to.

import type { DoorObjection } from "@/lib/objections";

export type ScriptStepKey =
  "intro_need" | "close" | "info" | "separate_spouse" | "set_stage" | "confirmation";

export type ScriptLine = {
  /** "say" = spoken, shown big; "note" = stage direction, shown muted. */
  kind: "say" | "note";
  text: string;
};

export type ScriptStep = {
  key: ScriptStepKey;
  order: number;
  /** Short stepper chip label. */
  label: string;
  /** The step heading as the script names it. */
  title: string;
  lines: ScriptLine[];
};

export const SCRIPT_STEPS: ScriptStep[] = [
  {
    key: "intro_need",
    order: 1,
    label: "Intro/Need",
    title: "Intro / Need",
    lines: [
      {
        kind: "say",
        text: "Good morning! Beautiful home – the reason I stopped by was I noticed ____ (insert damage here).",
      },
      { kind: "say", text: "Quick question – how long have you owned the home?" },
      { kind: "note", text: "EDUCATION – point out the damage + the consequence of the damage." },
      { kind: "say", text: "Eventually you're going to get that inspected, RIGHT?" },
      { kind: "say", text: "Do you have any leaks?" },
      { kind: "say", text: "When was the last time you popped your head in the attic?" },
      { kind: "say", text: "Anyone in the home have any respiratory issues?" },
      { kind: "say", text: "When was the last time the roof was done?" },
      {
        kind: "note",
        text: "Rhythm: Question, Education, Question, Education, Question, Education.",
      },
    ],
  },
  {
    key: "close",
    order: 2,
    label: "Close",
    title: "Close",
    lines: [
      {
        kind: "say",
        text: "Here is what I'm going to do… my guys are in the area, I'm going to put you at the top of my list for a free inspection tomorrow – what time works best for you and your SPOUSE – MORNING or AFTERNOON?",
      },
      { kind: "say", text: "2 or 6?" },
    ],
  },
  {
    key: "info",
    order: 3,
    label: "Info",
    title: "Info",
    lines: [
      { kind: "note", text: "Introduce yourself and fill out the lead sheet." },
      {
        kind: "say",
        text: "Excuse me – my name is ____ and you are? And how do I spell your last name? And how do I spell your spouse's name?",
      },
      { kind: "say", text: "And your address is 123 ____ St., and this is 92107?" },
      {
        kind: "say",
        text: "Just in case we are running a little late – we value your time – the best number to get a hold of you is 619 or 760?",
      },
    ],
  },
  {
    key: "separate_spouse",
    order: 4,
    label: "Spouse",
    title: "Separate the Spouse",
    lines: [
      { kind: "note", text: "Make sure ALL homeowners will be present for the inspection." },
      {
        kind: "say",
        text: "Now tomorrow at ___ is a good time for you – you won't be on work calls or going to the gym? And your spouse ____, she won't be picking up the kids or working from home?",
      },
    ],
  },
  {
    key: "set_stage",
    order: 5,
    label: "Stage",
    title: "Set the Stage",
    lines: [
      {
        kind: "say",
        text: "Now tomorrow at ___, my guy will come out and do a full inspection for you. Take measurements and pictures. Then he will sit down with you, show you a copy of our credentials – license, bond, insurance – show you some styles and options to choose from, and leave you an exact price in writing for if and when you're ready. FAIR ENOUGH?",
      },
    ],
  },
  {
    key: "confirmation",
    order: 6,
    label: "Confirm",
    title: "Confirmation",
    lines: [
      {
        kind: "say",
        text: "What will happen next: in 5–10 minutes my office is going to give you a call to confirm tomorrow's appointment. If you do not answer the call, there will be no inspection and they will send me back :) – Have a great day!",
      },
    ],
  },
];

/** The INFO step asks in this order — set the Monday lead form (board
 *  4155518549's app clone, src/lib/monday-form.ts) to the same question
 *  order. The form builder is the only place this can be changed; the app
 *  just embeds it. */
export const LEAD_FORM_FIELD_ORDER = [
  "Homeowner name (first + last, spelled)",
  "Spouse name (spelled)",
  "Address",
  "ZIP",
  "Best phone number",
] as const;

// ── Rebuttals ────────────────────────────────────────────────────────────────
// Keyed by the exact objection label stored in field_pins.objection
// (src/lib/objections.ts). Structure: Empathy → Clarification → Realignment,
// realignment always ends in a two-option question. One short line each.

export type Rebuttal = {
  objection: DoorObjection;
  empathy: string;
  clarification: string;
  realignment: string;
};

export const REBUTTALS: Rebuttal[] = [
  {
    objection: "Have a guy",
    empathy: "Love that — a good guy is gold.",
    clarification: "Has he been up there since the last storm?",
    realignment: "Use our free report to grade his work — morning or afternoon?",
  },
  {
    objection: "Not interested",
    empathy: "Totally fair — I showed up out of nowhere.",
    clarification: "Is it the timing, or you figure the roof's fine?",
    realignment: "It's free and you keep the report either way — 2 or 6?",
  },
  {
    objection: "No money",
    empathy: "I hear you — nobody budgets for a roof.",
    clarification: "The inspection costs nothing — the leak is what gets expensive.",
    realignment: "Get the free report now, decide later — morning or afternoon?",
  },
  {
    objection: "Not now",
    empathy: "No problem — I caught you mid-day.",
    clarification: "It's 20 minutes and you don't climb anything.",
    realignment: "My guys are already out here tomorrow — 2 or 6?",
  },
  {
    objection: "Talk to my spouse",
    empathy: "Smart — big calls are team calls.",
    clarification: "That's exactly why we book it when you're BOTH home.",
    realignment: "What works for the two of you — morning or afternoon?",
  },
  {
    objection: "Other",
    empathy: "Fair enough — give it to me straight.",
    clarification: "If the inspection's free, what's the real hang-up?",
    realignment: "Worst case you get a free report — tomorrow or the weekend?",
  },
];

export const rebuttalFor = (objection: string): Rebuttal | null =>
  REBUTTALS.find((r) => r.objection === objection) ?? null;
