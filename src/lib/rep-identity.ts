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
 *   0. alias — an admin has explicitly bound this handle to a board name
 *      (kombat_rep_aliases). The only tier that can resolve a single-token
 *      handle ("CurtofWest" → "Curtis Westergard"); authoritative, so it wins
 *      outright and never falls through to a guess.
 *   1. exact normalized match
 *   2. same token multiset (order swaps, "Paz Jonathan")
 *   3. exact last token (≥4 chars) + first-token prefix ≥3 either direction
 *      ("Jon Paz" ↔ "Jonathan Paz")
 * A string tier (1–3) only wins when it matches EXACTLY ONE candidate —
 * ambiguity means no match, never a guess.
 */

// Curly quotes included: iOS smart punctuation types ’, and a profile saved
// as "Josh O’Connor" must still match the board's "Josh OConnor" (Weekly
// Action Plan rollout 2026-10-01 — his 8 jobs were invisible without this).
const tokens = (s: string): string[] =>
  normalizeName(s).replace(/[.'’‘]/g, "").split(" ").filter(Boolean);

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
  /**
   * Optional handle→board-name aliases, keyed by NORMALIZED display name
   * (normalizeName), value = the raw canonical board name. Pass
   * `useRepAliases()` here. Omitted → pure string matching, exactly as before.
   */
  aliases?: ReadonlyMap<string, string>,
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

  // Tier 0 — alias. An admin has explicitly declared "this handle IS this
  // board name", so it's authoritative: resolve the canonical against the
  // pool and stop. If the aliased name isn't in THIS pool the rep just has
  // nothing here — return no match rather than letting a stylized handle
  // ("CurtofWest") fall through to a fuzzy tier and mis-bind onto a stranger.
  if (aliases) {
    const canon = aliases.get(me);
    if (canon !== undefined) {
      const key = normalizeName(canon);
      const hit = byNorm.get(key) ?? null;
      if (hit) return { matched: hit, isMe: (rep) => normalizeName(rep) === key };
      return { matched: null, isMe: () => false };
    }
  }

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
