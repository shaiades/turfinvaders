// Phone-room vocabulary for Dial Run — the confirmation department's no-map
// Active Run (owner mandate 2026-10-19: "count their dials as knocks, use the
// same vocab"). Dispositions ARE pin_type values on purpose: call_logs reuses
// the enum, and the bump_daily_log_from_call trigger (migration
// 20261101120000) mirrors the pin trigger, so a dial lands in daily_logs as a
// knock and every board shares one vocabulary. Pure data — no JSX, no
// supabase — so verify-dialer.ts can pin it from node.

import type { PinType } from "@/lib/pin-results";

/** The dispositions call_logs accepts (the migration's CHECK constraint).
 *  `knock` is a bare dial — logged the moment the call is placed, upgraded in
 *  place when an outcome chip is tapped. renter/appt are door-only. */
export const CALL_DISPOSITIONS = [
  "knock",
  "not_home",
  "talked_to",
  "not_interested",
  "go_back",
  "lead",
] as const satisfies readonly PinType[];
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export function isCallDisposition(v: unknown): v is CallDisposition {
  return (CALL_DISPOSITIONS as readonly unknown[]).includes(v);
}

/** The five outcome chips (owner pick 2026-10-19). Colors match the door
 *  picker's for the same disposition (pin-results.ts) — one color language
 *  across both channels. Lead keeps the field's neon green. */
export const CALL_RESULTS: Array<{
  type: Exclude<CallDisposition, "knock">;
  /** Short badge/legend form. */
  label: string;
  /** The words the sheets/grids spell out. */
  fullLabel: string;
  /** Caption under the tap chips. */
  chipLabel: string;
  color: string;
}> = [
  {
    type: "not_home",
    label: "NA",
    fullLabel: "No Answer",
    chipLabel: "No Answer",
    color: "#ff2d55",
  },
  {
    type: "talked_to",
    label: "Talk",
    fullLabel: "Talked To",
    chipLabel: "Talked To",
    color: "#ffd60a",
  },
  {
    type: "go_back",
    label: "CB",
    fullLabel: "Callback",
    chipLabel: "Callback",
    color: "#00e5ff",
  },
  {
    type: "not_interested",
    label: "NI",
    fullLabel: "Not Interested",
    chipLabel: "Not Int.",
    color: "#ff6b00",
  },
  {
    type: "lead",
    label: "Lead",
    fullLabel: "Lead",
    chipLabel: "LEAD",
    color: "#39ff14",
  },
];

/** Phone-flavored labels for the shared pin vocabulary — what the stats
 *  grids ("On the Phone · This Week") call each disposition. */
export const CALL_LABELS: Record<CallDisposition, string> = {
  knock: "DIAL",
  not_home: "NO ANSWER",
  talked_to: "TALKED TO",
  not_interested: "NOT INTERESTED",
  go_back: "CALLBACK",
  lead: "LEAD GENERATED",
};

/** daily_logs deltas per disposition — a row-for-row mirror of
 *  bump_daily_log_from_call (every call +1 doors; conversations +1 talked;
 *  not_interested / not_home keep their buckets). verify-dialer.ts pins this
 *  table against the trigger's CASE arms; change the two together. */
export const CALL_COUNTER_DELTAS: Record<
  CallDisposition,
  { doors_knocked: number; people_talked_to: number; not_interested: number; not_home: number }
> = {
  knock: { doors_knocked: 1, people_talked_to: 0, not_interested: 0, not_home: 0 },
  not_home: { doors_knocked: 1, people_talked_to: 0, not_interested: 0, not_home: 1 },
  talked_to: { doors_knocked: 1, people_talked_to: 1, not_interested: 0, not_home: 0 },
  not_interested: { doors_knocked: 1, people_talked_to: 1, not_interested: 1, not_home: 0 },
  go_back: { doors_knocked: 1, people_talked_to: 1, not_interested: 0, not_home: 0 },
  lead: { doors_knocked: 1, people_talked_to: 1, not_interested: 0, not_home: 0 },
};

/** Conversation dispositions — the ones that count people_talked_to, build
 *  the talk combo, and can roll a mystery drop. A no-answer breaks the run. */
export const CALL_TALK_TYPES: ReadonlySet<CallDisposition> = new Set([
  "talked_to",
  "go_back",
  "lead",
  "not_interested",
]);

/** ActiveRun's streak rule, phone-tuned: conversations chain, a no-answer
 *  breaks the run, and a bare dial holds it (the outcome isn't known yet —
 *  the chip that tags it delivers the verdict). Returns the next count. */
export function nextCombo(combo: number, disposition: CallDisposition): number {
  if (disposition === "knock") return combo;
  return CALL_TALK_TYPES.has(disposition) ? combo + 1 : 0;
}

/** Result toasts — RESULT_TOASTS' phone cousins. */
export const CALL_TOASTS: Partial<Record<CallDisposition, string>> = {
  lead: "🟢 LEAD — work it on the board!",
  not_home: "🔴 No answer",
  go_back: "🔵 Callback — hit them again later",
  not_interested: "🟠 Not interested",
  talked_to: "🟡 Talked to",
};
