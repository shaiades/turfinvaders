// My Purpose — prompt interpolation helpers. Later steps quote the rep's own
// earlier words back at them ("You said you want {why_2} — why does that
// matter?"), so every helper here must degrade to a readable sentence when an
// answer is missing, edited away, or stored as json instead of text. Pure:
// no React, no supabase, no side effects.

import type { AnswerMap, AnswerValue } from "./types";

function isStringArray(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((s) => typeof s === "string");
}

/** Pull the human-readable text out of an answer, wherever it lives.
 *  Order matters: a typed .text wins; json shapes ({text}, {values}/
 *  {selections}, bare string[]) are the composite kinds (why_6, multi-selects,
 *  dual/if-then). Anything else — numbers, dates, unknown json — yields ""
 *  and lets the caller's fallback carry the sentence. */
export function answerDisplayText(v: AnswerValue | undefined): string {
  if (!v) return "";
  if (typeof v.text === "string" && v.text.trim().length > 0) return v.text;
  const j = v.json;
  if (j !== null && typeof j === "object" && !Array.isArray(j)) {
    const obj = j as Record<string, unknown>;
    // Non-empty, like top-level .text — why_6 is {values, text} and an empty
    // free-text half must not mask the chip picks below it.
    if (typeof obj.text === "string" && obj.text.trim().length > 0) return obj.text;
    if (isStringArray(obj.values)) return obj.values.join(", ");
    if (isStringArray(obj.selections)) return obj.selections.join(", ");
  }
  if (isStringArray(j)) return j.join(", ");
  return "";
}

/** An answer cleaned up for quoting inside a prompt: whitespace collapsed,
 *  surrounding quote marks and trailing punctuation shed (the template adds
 *  its own), truncated at a word boundary. `max` (default 90) bounds the
 *  RESULT including the appended "…", so interpolated prompts can't blow up
 *  a card layout. Empty answers return `fallback` (default ""). */
export function quoteAnswer(
  a: AnswerMap,
  key: string,
  opts?: { max?: number; fallback?: string },
): string {
  const max = opts?.max ?? 90;
  let s = answerDisplayText(a[key]).replace(/\s+/g, " ").trim();
  // Shed wrapping quotes (straight or curly) — reps often quote themselves.
  s = s.replace(/^["'‘’“”]+/, "").replace(/["'‘’“”]+$/, "");
  s = s.replace(/[.!?,;:…]+$/, "").trim();
  if (s.length > max) {
    const cut = s.slice(0, Math.max(1, max - 1));
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.!?,;:…]+$/, "") + "…";
  }
  if (s.length === 0) return opts?.fallback ?? "";
  return s;
}

/** Per-level grammatical stand-ins so a Seven Levels prompt still reads as a
 *  sentence when the prior answer is missing or was edited away. Each slots
 *  into "…you said you want {X}…"-shaped copy. */
export const WHY_FALLBACKS: Record<number, string> = {
  1: "your goal",
  2: "what you described",
  3: "the person you described",
  4: "the people this would affect",
  5: "what staying the same could cost",
  6: "what you are trying to create or protect",
  7: "your reason",
};

/** Quote the answer to Seven Levels question `level` (key `why_${level}`),
 *  falling back to that level's grammatical stand-in. An out-of-range level
 *  gets the generic "your reason". */
export function whyQuote(a: AnswerMap, level: number, opts?: { max?: number }): string {
  const fallback: string | undefined = WHY_FALLBACKS[level];
  return quoteAnswer(a, `why_${level}`, { max: opts?.max, fallback: fallback ?? "your reason" });
}

/** Replace `{slot}` tokens with their values. Unknown slots are left intact
 *  so a template/content mismatch shows up on screen instead of silently
 *  swallowing words. */
export function fillTemplate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (token, name: string) => {
    const value: string | undefined = slots[name];
    return value === undefined ? token : value;
  });
}
