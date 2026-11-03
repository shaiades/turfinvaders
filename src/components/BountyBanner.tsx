// §6 Bounties — the field banner for any active bounty. Since the 2026-10-15
// audit a bounty really SCORES: legacy multiplies confirmed leads set in the
// window (getDispatchProduction.bountyPts); with score_v2 on the SQL triggers
// honor the category per grant. The banner says exactly what scores and
// nothing else: no banner may promise something that doesn't score. During
// the FINAL ROUND it wears the fight-ROUND framing ("ROUND 3 — SIT WEEK ×2",
// Tier 3 of the 2026-11-03 engagement audit). Renders nothing when none are
// live. Mounted under the header for field roles.

import { useActiveBounties, type BountyCategory } from "@/hooks/useBounties";
import { useArcadeScore } from "@/hooks/useArcadeScore";
import { useAuth } from "@/hooks/useAuth";
import { finaleActive, finalePace } from "@/lib/canvasser-arcade";

function endsIn(iso: string): string {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60_000));
  if (m < 60) return `${m}m left`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m left`;
  return `${Math.floor(m / 1440)}d left`;
}

const PER: Record<BountyCategory, string> = {
  doors: "pts per conversation",
  leads: "pts per lead",
  sit: "pts per sit",
  sale: "pts per sale",
};
const WEEK_NAME: Record<BountyCategory, string> = {
  doors: "DOOR WEEK",
  leads: "LEAD WEEK",
  sit: "SIT WEEK",
  sale: "SALE WEEK",
};

export function BountyBanner() {
  const { user, previewCanvasserId } = useAuth();
  const bounties = useActiveBounties();
  const score = useArcadeScore(previewCanvasserId ?? user?.id);
  if (bounties.length === 0) return null;

  // Category copy only once v2 actually scores categories; legacy multiplies
  // leads whatever the row says, so the banner keeps saying leads.
  const catOf = (c: BountyCategory): BountyCategory => (score.enabled ? c : "leads");
  // FINAL ROUND framing: a multi-day bounty during the finale IS the round's
  // stage ("ROUND 3 — SIT WEEK ×2").
  const inFinale = score.enabled && finaleActive(score.rules);
  const round = inFinale ? finalePace(0, score.rules)?.round : null;

  return (
    <div className="space-y-1 border-b border-border bg-surface/60 px-3 py-1.5">
      {bounties.map((b) => {
        const cat = catOf(b.category);
        const longHaul = new Date(b.ends_at).getTime() - Date.now() > 24 * 3_600_000;
        const finaleWeek = inFinale && round && longHaul;
        return (
          <div
            key={b.id}
            className="flex items-center gap-2 rounded-md px-2 py-1"
            style={{
              background: finaleWeek
                ? "color-mix(in oklab, var(--kombat-red) 16%, transparent)"
                : "color-mix(in oklab, var(--warning) 14%, transparent)",
            }}
          >
            <span aria-hidden>{finaleWeek ? "🥊" : "⏱️"}</span>
            <span
              className={`shrink-0 font-display text-[11px] uppercase tracking-widest ${
                finaleWeek ? "text-[var(--kombat-gold)]" : "text-[var(--warning)]"
              }`}
            >
              {finaleWeek
                ? `ROUND ${round.roundNumber} — ${WEEK_NAME[cat]} ×${b.multiplier}`
                : `${b.multiplier}× ${PER[cat]}`}
            </span>
            <span className="truncate text-[11px] text-foreground/90">· {b.label}</span>
            <span className="ml-auto shrink-0 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
              {endsIn(b.ends_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
