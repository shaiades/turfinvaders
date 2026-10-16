import { normalizeName } from "@/lib/utils";

/** Pseudo lead-source channels the Monday webhook credits when a card has no
 *  Agent (Self Gen, Job Walk, …). They live in profiles like people but must
 *  never be renamed, merged, moved, or archived — the webhook would recreate
 *  them and channel credit would be hijacked. Client twin of the SQL
 *  is_pseudo_source_name (20260816010000) and of SOURCE_FALLBACKS in
 *  monday-live-dispatch/index.ts — extend all three together.
 *  suspension_tracked=false is NOT a usable marker: the suspension ✕ also
 *  clears it on real people. */
export const LEAD_SOURCE_KEYS: ReadonlySet<string> = new Set(
  [
    "Self Gen",
    "Job Walk",
    "Reload",
    "Upsell",
    "Rehash / Cynthia King",
    "Referral",
    "Ryan appointinator",
  ].map(normalizeName),
);

export const isLeadSourceKey = (key: string) => LEAD_SOURCE_KEYS.has(key);

export const isLeadSourceName = (name: string | null | undefined) =>
  LEAD_SOURCE_KEYS.has(normalizeName(name));

/** Non-person profile rows (conversion audit 2026-10-15): lead-source
 *  channels, test rows, and compound "A & B" attribution names. The Monday
 *  webhook keeps crediting them, but they never appear on canvasser lists,
 *  leaderboards, or the View As picker. Name-based twin of
 *  profiles.non_person (20261027120000) so the UI hides them even before the
 *  flag backfill runs — extend both together. */
export const isNonPersonName = (name: string | null | undefined): boolean => {
  const key = normalizeName(name);
  return key === "" || key === "test" || key.includes("&") || LEAD_SOURCE_KEYS.has(key);
};
