// §5 — the captain's Van Wars command card (owner, 2026-10-05). On the Command
// tab: where their crew sits in THIS week's race, their war score, and the gap
// to #1, with a tap through to the full race (where the daily captain callout
// lives). Reuses useVanWars — the same week ladder the field board shows, so
// the two can never disagree. Renders nothing until the race is live (2+ crews)
// and the captain's own crew has production this week.
//
// (Crew combined-level + the "Captain of the Week" crown land with lifetime XP
// and the Saturday crowning respectively — tracked in the roadmap.)

import { Link } from "@tanstack/react-router";
import { Trophy } from "lucide-react";
import { ArcadeCard } from "@/components/arcade";
import { useVanWars } from "@/hooks/useVanWars";

const GTA = "'Arial Black', Impact, 'Franklin Gothic Heavy', sans-serif";
const CASH = "#9bf00b";
const fmtCash = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;

export function CaptainVanWarsCard({ teamId }: { teamId: string | null }) {
  const { standings, loading } = useVanWars();
  if (loading || standings.length < 2 || !teamId) return null;
  const idx = standings.findIndex((s) => s.teamId === teamId);
  if (idx < 0) return null;

  const crew = standings[idx];
  const gap = Math.max(0, standings[0].war - crew.war);
  const first = idx === 0;
  const color = crew.color;

  return (
    <ArcadeCard className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Trophy className="h-5 w-5 shrink-0" style={{ color }} />
          <div className="min-w-0">
            <div className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
              Van Wars · this week
            </div>
            <div className="mt-0.5 font-display text-sm uppercase" style={{ color }}>
              Your crew · #{idx + 1} of {standings.length}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-5">
          <div className="text-right">
            <div style={{ fontFamily: GTA, fontSize: 28, lineHeight: 1, color }}>
              {Math.round(crew.war)}
            </div>
            <div className="font-display text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
              War / head
            </div>
          </div>
          <div className="text-right">
            {first ? (
              <div className="font-display text-[11px] uppercase tracking-widest text-[var(--kombat-gold)]">
                👑 #1 — defend it
              </div>
            ) : (
              <>
                <div
                  style={{ fontFamily: GTA, fontSize: 20, lineHeight: 1, color: "var(--warning)" }}
                >
                  {Math.round(gap)}
                </div>
                <div className="font-display text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
                  to #1
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
        <span className="font-display text-[10px] uppercase tracking-wide text-muted-foreground">
          {crew.pts} pts · {crew.knockers} {crew.knockers === 1 ? "knocker" : "knockers"} ·{" "}
          <span style={{ color: CASH }}>{crew.vol > 0 ? fmtCash(crew.vol) : "desk"}</span>
        </span>
        <Link
          to="/leaderboard"
          className="inline-flex min-h-11 items-center rounded-lg border border-neon/40 bg-neon/10 px-3 font-display text-[10px] uppercase tracking-widest text-neon transition hover:bg-neon/20 md:min-h-0"
        >
          Open Van Wars · fire a callout →
        </Link>
      </div>
    </ArcadeCard>
  );
}
