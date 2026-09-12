import { normalizeName } from "@/lib/utils";

/**
 * Rep self-identity for Close Kombat (rep audit R-4, 2026-09-12).
 *
 * Standings rows are keyed by RAW Monday board name strings — there is no
 * FK from block_cards reps to auth users. The old check was whole-string
 * equality of profiles.display_name, so "Jon Paz" on the board vs "Jonathan
 * Paz" in the profile silently killed the gold "you" row — and every
 * rep-scoped surface (MY DEALS, my-cards attention, KA-CHING) needs the
 * same answer to "which rows are mine".
 *
 * The ladder is deliberately CONSERVATIVE — a false positive paints someone
 * else's money as yours, which is worse than no match (the house has two
 * distinct Ryans AND a "Jorge N" / "Jorge Najera" pair as separate people):
 *   1. exact normalized match
 *   2. same token multiset (order swaps, "Paz Jonathan")
 *   3. exact last token (≥4 chars) + first-token prefix ≥3 either direction
 *      ("Jon Paz" ↔ "Jonathan Paz")
 * A tier only wins when it matches EXACTLY ONE candidate — ambiguity means
 * no match, never a guess.
 */

const tokens = (s: string): string[] =>
  normalizeName(s).replace(/[.']/g, "").split(" ").filter(Boolean);

const sortedKey = (s: string): string => tokens(s).sort().join(" ");

function tier3Matches(mine: string[], theirs: string[]): boolean {
  if (mine.length < 2 || theirs.length < 2) return false;
  const myLast = mine[mine.length - 1];
  const theirLast = theirs[theirs.length - 1];
  if (myLast.length < 4 || myLast !== theirLast) return false;
  const a = mine[0];
  const b = theirs[0];
  if (a.length < 3 || b.length < 3) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export type RepMatcher = {
  /** The board name resolved as "me", or null when nothing matched safely. */
  matched: string | null;
  isMe: (rep: string) => boolean;
};

export function buildRepMatcher(
  displayName: string | null | undefined,
  boardReps: readonly string[],
): RepMatcher {
  const me = normalizeName(displayName);
  if (me === "" || boardReps.length === 0) {
    return { matched: null, isMe: () => false };
  }

  // Dedupe by NORMALIZED name: "JOSH OCONNOR" and "Josh OConnor" are the
  // same person spelled twice, and counting them as two candidates made
  // every tier "ambiguous" — a false-negative regression vs the old
  // lowercase equality (review 2026-09-12).
  const byNorm = new Map<string, string>();
  for (const r of boardReps) {
    const k = normalizeName(r);
    if (k !== "" && !byNorm.has(k)) byNorm.set(k, r);
  }
  const uniq = [...byNorm.values()];

  const pick = (candidates: string[]): string | null =>
    candidates.length === 1 ? candidates[0] : null;

  const matched =
    pick(uniq.filter((r) => normalizeName(r) === me)) ??
    pick(uniq.filter((r) => sortedKey(r) === sortedKey(me))) ??
    pick(uniq.filter((r) => tier3Matches(tokens(me), tokens(r))));

  if (!matched) return { matched: null, isMe: () => false };
  const key = normalizeName(matched);
  return { matched, isMe: (rep) => normalizeName(rep) === key };
}
