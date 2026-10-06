// Kombat Month — "Everyone" (owner revamp 2026-10-02): the competition. A
// gold/silver/bronze podium up top, then the full ladder with belt badges,
// count-up totals, and gap-to-next needling ("12 behind Jaxon — pass him").
// Pure presentation over the ledger totals.

import { ArcadeSkeleton, ArcadePanel } from "@/components/arcade";
import { useCountUp } from "@/hooks/useCountUp";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { BELT_ACCENT, fmtPts, tierFor, type KombatRules, type RepTotals } from "@/lib/kombat-month";
import type { RepMatcher } from "@/lib/rep-identity";
import { RepAvatar } from "@/components/RepAvatar";
import { cartoonFor, type RepCartoon } from "@/hooks/useRepCartoons";

const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;
const PODIUM_ACCENT = ["var(--kombat-gold)", "var(--muted-foreground)", "var(--kombat-red)"];

export function KombatLeaderboard({
  totals,
  rules,
  matcher,
  loading,
  cartoons,
}: {
  totals: RepTotals[];
  rules: KombatRules;
  matcher: RepMatcher;
  loading: boolean;
  cartoons?: Map<string, RepCartoon>;
}) {
  const reduced = usePrefersReducedMotion();
  const podium = totals.slice(0, 3);
  // Podium renders 2nd · 1st · 3rd so #1 sits center and tallest.
  const podiumOrder = podium.length === 3 ? [podium[1], podium[0], podium[2]] : podium;

  return (
    <ArcadePanel title="Everyone" faction="kombat" status="good">
      {loading ? (
        <ArcadeSkeleton className="h-64" />
      ) : totals.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No points on the board yet — the first synced October sale opens the contest.
        </p>
      ) : (
        <>
          {podium.length >= 3 && (
            <div className="mb-5 grid grid-cols-3 items-end gap-2">
              {podiumOrder.map((t) => {
                const place = podium.indexOf(t); // 0,1,2
                return (
                  <PodiumCard
                    key={t.rep_name}
                    total={t}
                    place={place}
                    rules={rules}
                    me={matcher.isMe(t.rep_name)}
                    reduced={reduced}
                    cartoon={cartoonFor(cartoons, t.rep_name)}
                  />
                );
              })}
            </div>
          )}

          <ol className="space-y-1.5">
            {totals.map((t, i) => (
              <LadderRow
                key={t.rep_name}
                total={t}
                rank={i + 1}
                ahead={i > 0 ? totals[i - 1] : null}
                rules={rules}
                me={matcher.isMe(t.rep_name)}
                reduced={reduced}
                cartoon={cartoonFor(cartoons, t.rep_name)}
              />
            ))}
          </ol>
        </>
      )}
    </ArcadePanel>
  );
}

function PodiumCard({
  total,
  place,
  rules,
  me,
  reduced,
  cartoon,
}: {
  total: RepTotals;
  place: number;
  rules: KombatRules;
  me: boolean;
  reduced: boolean;
  cartoon?: RepCartoon;
}) {
  const accent = PODIUM_ACCENT[place];
  const pts = useCountUp(total.total, reduced);
  const belt = tierFor(total.total, rules).current;
  // #1 center is tallest; 2nd/3rd shorter.
  const pad = place === 0 ? "pt-5 pb-4" : "pt-3 pb-3 mt-4";
  return (
    <div
      className={
        "min-w-0 rounded-md border text-center px-2 " +
        pad +
        (place === 0 ? " kombat-champion" : "") +
        (me ? " ring-1 ring-kombat-gold" : "")
      }
      style={{
        borderColor: `color-mix(in oklab, ${accent} 55%, transparent)`,
        background: `color-mix(in oklab, ${accent} 10%, transparent)`,
      }}
    >
      <div className="mb-1 flex justify-center">
        <RepAvatar
          name={total.rep_name}
          cartoon={cartoon}
          missing={!(cartoon?.portrait || cartoon?.full)}
          className={place === 0 ? "h-16 w-16" : "h-12 w-12"}
          textClassName={place === 0 ? "text-base" : "text-xs"}
          ring={place === 0}
        />
      </div>
      <div className="text-lg leading-none">
        {place === 0 ? <span className="kombat-crown">👑</span> : place === 1 ? "🥈" : "🥉"}
      </div>
      <div
        className="mt-1 truncate font-display text-[10px] uppercase tracking-widest"
        style={{ color: accent }}
      >
        {firstName(total.rep_name)}
      </div>
      <div
        className={
          "mt-1 font-mono tabular-nums text-lg font-bold" +
          (place === 0 ? " kombat-score-flare" : "")
        }
        style={{ color: accent }}
      >
        {fmtPts(pts.display)}
      </div>
      {belt && (
        <div className="mt-0.5 text-[9px] uppercase tracking-widest text-muted-foreground truncate">
          {belt.label}
        </div>
      )}
    </div>
  );
}

function LadderRow({
  total,
  rank,
  ahead,
  rules,
  me,
  reduced,
  cartoon,
}: {
  total: RepTotals;
  rank: number;
  ahead: RepTotals | null;
  rules: KombatRules;
  me: boolean;
  reduced: boolean;
  cartoon?: RepCartoon;
}) {
  const pts = useCountUp(total.total, reduced);
  const belt = tierFor(total.total, rules).current;
  const beltAccent = belt
    ? (BELT_ACCENT[belt.key] ?? "var(--kombat-gold)")
    : "var(--muted-foreground)";
  const rankColor =
    rank === 1 ? "text-kombat-gold" : rank <= 3 ? "text-victory" : "text-muted-foreground";
  const gap = ahead ? ahead.total - total.total : 0;
  return (
    <li
      className={
        "flex items-center gap-3 rounded-md border px-3 py-2.5 " +
        (me
          ? "border-kombat-gold/60 bg-[color-mix(in_oklab,var(--kombat-gold)_10%,transparent)] kombat-you"
          : "border-border") +
        // One-shot gold ping the instant this rep's total ticks up.
        (pts.bump ? " kombat-rank-flash" : "")
      }
    >
      <span className={"w-6 shrink-0 text-right font-display text-xs tabular-nums " + rankColor}>
        {rank}
      </span>
      <RepAvatar
        name={total.rep_name}
        cartoon={cartoon}
        missing={!(cartoon?.portrait || cartoon?.full)}
        className="h-9 w-9"
        textClassName="text-[0.7rem]"
        ring={rank === 1}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{total.rep_name}</span>
          {me && (
            <span className="shrink-0 text-[10px] text-kombat-gold font-display uppercase tracking-widest">
              you
            </span>
          )}
          {!(cartoon?.portrait || cartoon?.full) && (
            <span className="shrink-0 font-display text-[8px] uppercase tracking-widest text-muted-foreground/60">
              Photo needed
            </span>
          )}
        </span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {rank === 1
            ? "top of the board 👑"
            : `${fmtPts(gap)} behind ${firstName(ahead!.rep_name)}`}
        </span>
      </span>
      {belt && (
        <span
          className="shrink-0 rounded-full border px-2 py-0.5 font-display text-[9px] uppercase tracking-widest"
          style={{
            color: beltAccent,
            borderColor: `color-mix(in oklab, ${beltAccent} 45%, transparent)`,
          }}
        >
          {belt.label}
        </span>
      )}
      <span
        className={
          "w-16 shrink-0 text-right font-mono tabular-nums text-sm font-semibold " +
          (pts.bump
            ? "transition-transform duration-200 scale-110 text-kombat-gold"
            : "transition-transform duration-200")
        }
      >
        {fmtPts(pts.display)}
      </span>
    </li>
  );
}
