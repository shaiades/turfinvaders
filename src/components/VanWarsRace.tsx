// Van Wars — the weekly street race (§3). Crews race down a lit drag strip:
// a van's position is its war score (points per active knocker, so a small
// crew can take the block), it lurches with a nitrous burst when the crew
// surges and sparks on a sale, the leader wears the crown and the dethroned
// crew gets SMOKED, and a full-width spray tag fires on a lead change with a
// hiss + haptic. Reduced-motion drops the animated strip for the static
// color-bar standings below it. Numbers ride useVanWars → the same week ladder
// the Solo board uses, so the two can never disagree. Captains can fire one
// preset callout a day at the leader. The Wall of Fame reads vanwars_wins
// (dark until the owner applies the migration + the Saturday crowning lands).

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useVanWars, type VanWarWin } from "@/hooks/useVanWars";
import { type VanWarStanding } from "@/lib/vanwars";
import { ArcadeCard, ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import { laTodayISO } from "@/lib/dates";

const fmtVol = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;

const CALLOUTS = [
  "COMING FOR THAT CROWN",
  "SEE YOU SATURDAY",
  "CATCH US IF YOU CAN",
  "THE BLOCK IS OURS",
];

/** A lowered, neon-underglow van silhouette in the crew's color. */
function VanSprite({ color, w = 84 }: { color: string; w?: number }) {
  return (
    <svg width={w} height={(w * 32) / 84} viewBox="0 0 94 34" style={{ color }} aria-hidden>
      <path
        d="M3 25 L3 19 Q3 16 8 15 L30 15 L41 8 Q46 5 55 6 L74 7 Q88 9 90 21 L90 25 Z"
        fill="currentColor"
        stroke="#04070e"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M33 15 L43 10 L54 10.5 L54 15 Z" fill="#bfe6ff" opacity=".5" />
      <path d="M57 10.6 L72 11 L74 15 L57 15 Z" fill="#bfe6ff" opacity=".4" />
      <circle cx="24" cy="26" r="6.4" fill="#06090f" />
      <circle cx="24" cy="26" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="73" cy="26" r="6.4" fill="#06090f" />
      <circle cx="73" cy="26" r="6.4" fill="none" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

export function VanWarsRace() {
  const { user, realRole } = useAuth();
  const reduced = usePrefersReducedMotion();
  const { standings, leader, config, wins, loading } = useVanWars();

  // ── Live event detection: diff successive standings for a per-crew surge
  // (war up = nitro, $ up = sparks) and a change of leader (the spray).
  const prevWar = useRef(new Map<string, number>());
  const prevVol = useRef(new Map<string, number>());
  const prevLeader = useRef<string | null>(null);
  const seeded = useRef(false);
  const [surge, setSurge] = useState<Record<string, "war" | "sale">>({});
  const [smoked, setSmoked] = useState<string | null>(null);
  const [spray, setSpray] = useState<{ title: string; color: string; sub: string } | null>(null);
  const sprayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const surgeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fireSpray = (title: string, color: string, sub: string) => {
    setSpray({ title, color, sub });
    playArcadeSound("spray");
    haptic([30, 40, 30]);
    clearTimeout(sprayTimer.current);
    sprayTimer.current = setTimeout(() => setSpray(null), 2600);
  };

  useEffect(() => {
    if (standings.length === 0) return;
    const lead = standings[0]?.name ?? null;

    if (seeded.current && !reduced) {
      const nextSurge: Record<string, "war" | "sale"> = {};
      for (const v of standings) {
        const pv = prevVol.current.get(v.name);
        const pw = prevWar.current.get(v.name);
        if (pv !== undefined && v.vol > pv) nextSurge[v.name] = "sale";
        else if (pw !== undefined && v.war > pw + 1e-6) nextSurge[v.name] = "war";
      }
      if (Object.keys(nextSurge).length) {
        setSurge(nextSurge);
        const anySale = Object.values(nextSurge).includes("sale");
        playArcadeSound(anySale ? "coin" : "engine");
        haptic(anySale ? [10, 24, 10] : 16);
        clearTimeout(surgeTimer.current);
        surgeTimer.current = setTimeout(() => setSurge({}), 850);
      }
      if (prevLeader.current && lead && lead !== prevLeader.current) {
        setSmoked(prevLeader.current);
        fireSpray(`${lead}'S CREW TOOK THE BLOCK`, standings[0].color, "New leader on the strip");
      }
    }

    prevWar.current = new Map(standings.map((v) => [v.name, v.war]));
    prevVol.current = new Map(standings.map((v) => [v.name, v.vol]));
    prevLeader.current = lead;
    seeded.current = true;
  }, [standings, reduced]);

  useEffect(
    () => () => {
      clearTimeout(sprayTimer.current);
      clearTimeout(surgeTimer.current);
    },
    [],
  );

  // ── Captain callout: one preset a day, sprayed at the leader.
  const isCaptain = realRole === "captain";
  const calloutKey = `ti_vw_callout:${user?.id ?? "anon"}:${laTodayISO()}`;
  const [calloutUsed, setCalloutUsed] = useState(false);
  useEffect(() => {
    try {
      setCalloutUsed(localStorage.getItem(calloutKey) != null);
    } catch {
      /* private mode */
    }
  }, [calloutKey]);
  const fireCallout = (line: string) => {
    if (calloutUsed || !leader) return;
    fireSpray(line, leader.color, "Captain callout");
    setCalloutUsed(true);
    try {
      localStorage.setItem(calloutKey, "1");
    } catch {
      /* private mode */
    }
  };

  if (loading && standings.length === 0) {
    return <ArcadeSkeleton className="h-96 w-full" />;
  }
  if (standings.length < 2) {
    return (
      <ArcadeCard className="p-6 text-center text-sm text-muted-foreground">
        Van Wars lights up when two crews are on the board this week — first knocks stage the race.
      </ArcadeCard>
    );
  }

  const leaderWar = Math.max(1e-6, standings[0].war);
  const posPct = (w: number) => Math.min(88, Math.max(24, 30 + (w / leaderWar) * 56));

  return (
    <div className="space-y-4">
      {/* ── The drag strip (motion only) ───────────────────────────────── */}
      {!reduced && (
        <div
          className="relative overflow-hidden rounded-2xl border border-border"
          style={{
            background: "linear-gradient(180deg,#0a0f20 0%,#0a1326 30%,#070b16 62%,#05080f 100%)",
          }}
        >
          {/* skyline + horizon glow */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-28"
            style={{
              background:
                "radial-gradient(600px 120px at 30% 60%, color-mix(in oklab,var(--neon) 16%,transparent), transparent 70%),radial-gradient(500px 120px at 82% 50%, color-mix(in oklab,var(--kombat-red) 18%,transparent), transparent 70%)",
            }}
          />
          {/* title */}
          <div className="relative z-10 px-3 pt-3 text-center">
            <div
              className="font-display text-3xl italic leading-none"
              style={{
                background:
                  "linear-gradient(180deg,#ffffff 10%,#d6e8ff 40%,#8094b4 56%,#eaf4ff 74%,#aebfdc 100%)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
                filter: "drop-shadow(0 0 16px color-mix(in oklab,var(--neon) 55%,transparent))",
              }}
            >
              VAN WARS
            </div>
            <div className="mt-0.5 font-display text-[9px] uppercase tracking-[0.3em] text-neon">
              This week · crowned Saturday 6 PM
            </div>
          </div>

          {/* lanes */}
          <div className="relative z-10 mt-2 flex flex-col gap-0.5 px-1 pb-3">
            {standings.map((v, i) => {
              const isLeader = i === 0;
              const ev = surge[v.name];
              return (
                <div key={v.name} className="relative h-12">
                  {/* finish line */}
                  <span
                    aria-hidden
                    className="absolute inset-y-1 right-2 w-2.5"
                    style={{
                      background:
                        "repeating-conic-gradient(#eef4ff 0 25%, #0b0f18 0 50%) 0 0/6px 6px",
                      boxShadow: "0 0 14px 1px rgba(255,255,255,.35)",
                    }}
                  />
                  <div
                    className={`absolute top-1/2 flex flex-col items-center ${ev === "war" ? "vw-lurch" : ""}`}
                    style={{ left: `${posPct(v.war)}%`, transform: "translate(-50%,-60%)" }}
                  >
                    {isLeader && (
                      <svg
                        width="20"
                        height="12"
                        viewBox="0 0 22 14"
                        className="mb-0.5"
                        aria-hidden
                      >
                        <path
                          d="M1 13 L3 3 L8 8 L11 1 L14 8 L19 3 L21 13 Z"
                          fill="var(--kombat-gold)"
                          stroke="#6b4e00"
                          strokeWidth="1"
                        />
                      </svg>
                    )}
                    <span
                      className="font-display text-[12px] italic uppercase leading-none"
                      style={{
                        color: v.color,
                        WebkitTextStroke: "1px rgba(2,6,14,.85)",
                        textShadow: `0 0 10px ${v.color}`,
                      }}
                    >
                      {v.name}
                    </span>
                    <div className="relative">
                      {/* speed streaks */}
                      <span
                        aria-hidden
                        className="vw-streak absolute right-[58%] top-[46%] h-0.5 w-16 rounded"
                        style={{ background: `linear-gradient(90deg,transparent,${v.color})` }}
                      />
                      {/* nitro burst */}
                      {ev === "war" && (
                        <span
                          aria-hidden
                          className="vw-nitro absolute -left-3 top-2"
                          style={{ fontSize: 0 }}
                        >
                          <svg width="26" height="16" viewBox="0 0 30 20">
                            <path
                              d="M30 10 Q16 2 2 10 Q16 18 30 10 Z"
                              fill="#8fe3ff"
                              opacity="0.9"
                            />
                          </svg>
                        </span>
                      )}
                      <span className={ev === "sale" ? "vw-spark inline-block" : "inline-block"}>
                        <VanSprite color={v.color} w={isLeader ? 86 : 78} />
                      </span>
                      {/* underglow */}
                      <span
                        aria-hidden
                        className="absolute -bottom-0.5 left-1/2 h-3 w-20 -translate-x-1/2 rounded-full"
                        style={{ background: v.color, filter: "blur(5px)", opacity: 0.8 }}
                      />
                    </div>
                    {smoked === v.name && (
                      <span className="mt-0.5 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
                        — SMOKED —
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* vignette */}
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(130% 90% at 50% 40%, transparent 55%, rgba(0,0,0,.6) 100%)",
            }}
          />

          {/* lead-change / callout spray */}
          {spray && (
            <div
              className="vw-spray-in absolute inset-x-3 bottom-3 z-20 rounded-xl border p-3"
              style={{
                borderColor: `color-mix(in oklab, ${spray.color} 55%, transparent)`,
                background: `linear-gradient(100deg, color-mix(in oklab, ${spray.color} 22%, transparent), rgba(8,14,26,.92) 62%)`,
                boxShadow: `0 10px 30px -14px ${spray.color}`,
              }}
            >
              <div
                className="font-display text-xl italic leading-none"
                style={{ color: "#eafcff", textShadow: `0 0 20px ${spray.color}` }}
              >
                {spray.title}
              </div>
              <div
                className="mt-1 font-display text-[9px] uppercase tracking-[0.22em]"
                style={{ color: spray.color }}
              >
                {spray.sub}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Standings HUD (also the reduced-motion view) ───────────────── */}
      <StandingsHud
        standings={standings}
        perHead={config.mode === "per_head"}
        leaderWar={leaderWar}
      />

      {/* ── Captain callout ────────────────────────────────────────────── */}
      {isCaptain && (
        <div className="space-y-2">
          <div className="font-display text-[9px] uppercase tracking-[0.2em] text-muted-foreground">
            {calloutUsed
              ? "Callout fired — back tomorrow"
              : "Captain callout · one a day, at the leader"}
          </div>
          <div className="flex flex-wrap gap-2">
            {CALLOUTS.map((c) => (
              <button
                key={c}
                type="button"
                disabled={calloutUsed}
                onClick={() => fireCallout(c)}
                className="min-h-11 flex-1 rounded-lg border px-3 py-2 font-display text-[11px] italic uppercase tracking-wider transition disabled:opacity-40 md:min-h-0"
                style={{
                  color: "var(--kombat-red)",
                  borderColor: "color-mix(in oklab, var(--kombat-red) 45%, transparent)",
                  background: "color-mix(in oklab, var(--kombat-red) 10%, transparent)",
                }}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Wall of Fame ───────────────────────────────────────────────── */}
      <WallOfFame wins={wins} />
    </div>
  );
}

function StandingsHud({
  standings,
  perHead,
  leaderWar,
}: {
  standings: VanWarStanding[];
  perHead: boolean;
  leaderWar: number;
}) {
  return (
    <ArcadeCard asChild className="overflow-hidden p-0">
      <section>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="font-display text-xs uppercase italic tracking-widest text-neon">
            Standings
          </h2>
          <span className="font-display text-[9px] uppercase tracking-widest text-muted-foreground">
            War {perHead ? "/ head" : "total"} · sit 1 · sale 2
          </span>
        </header>
        <ol>
          {standings.map((v, i) => (
            <li
              key={v.name}
              className="relative flex items-center gap-2.5 border-t border-border/50 px-4 py-2.5 first:border-t-0"
            >
              <span
                className={`w-4 text-center font-display text-sm tabular-nums ${i === 0 ? "text-[var(--kombat-gold)]" : "text-muted-foreground"}`}
              >
                {i + 1}
              </span>
              <span
                aria-hidden
                className="h-2.5 w-2.5 rotate-45"
                style={{ background: v.color, boxShadow: `0 0 8px ${v.color}` }}
              />
              <span
                className="min-w-0 flex-1 truncate font-display text-sm uppercase italic tracking-wide"
                style={{ color: i === 0 ? v.color : undefined }}
              >
                {v.name}
              </span>
              <span className="font-display text-base tabular-nums" style={{ color: v.color }}>
                {Math.round(v.war)}
              </span>
              <span className="flex items-center gap-2 font-display text-[10px] tabular-nums text-muted-foreground">
                <span>
                  {v.pts}p · {v.vol > 0 ? fmtVol(v.vol) : "desk"}
                </span>
                {v.sit.grade && (
                  <span
                    className="rounded px-1 text-[var(--kombat-black)]"
                    style={{ background: v.color }}
                    title={`${v.sit.sits}/${v.sit.leads} leads sat`}
                  >
                    {v.sit.grade}
                  </span>
                )}
              </span>
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 rounded"
                style={{
                  width: `${Math.min(100, (v.war / leaderWar) * 100)}%`,
                  background: v.color,
                  boxShadow: `0 0 8px ${v.color}`,
                }}
              />
            </li>
          ))}
        </ol>
        <p className="border-t border-border px-4 py-2.5 font-display text-[10px] leading-relaxed text-muted-foreground">
          War score = points per active knocker, so a small crew can still take the block. Ties
          break on sit rate.
        </p>
      </section>
    </ArcadeCard>
  );
}

function WallOfFame({ wins }: { wins: VanWarWin[] }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-4"
      style={{
        border: "1px solid color-mix(in oklab, var(--kombat-gold) 25%, transparent)",
        background:
          "linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,.6)),repeating-linear-gradient(92deg,#191c22 0 3px,#15181d 3px 6px),linear-gradient(180deg,#20242b,#111318)",
      }}
    >
      <div className="relative mb-3 font-display text-[10px] uppercase tracking-[0.26em] text-[#d7c29a]">
        The Wall of Fame
      </div>
      {wins.length === 0 ? (
        <p className="relative text-xs text-muted-foreground">
          No champions tagged yet — the first weekly winner gets sprayed here after Saturday's 6 PM
          crowning.
        </p>
      ) : (
        <div className="relative flex flex-col gap-3">
          {wins.map((w, i) => {
            const king = w.kind === "king";
            const color = w.color ?? "var(--kombat-gold)";
            return (
              <div
                key={`${w.week_start}-${w.kind}-${i}`}
                className="font-display text-xl italic uppercase leading-none"
                style={{
                  transform: "rotate(-2.5deg)",
                  color: king ? "var(--kombat-gold)" : color,
                  WebkitTextStroke: "1.1px rgba(0,0,0,.6)",
                  textShadow: king
                    ? "0 0 20px color-mix(in oklab,var(--kombat-gold) 80%,transparent)"
                    : `0 0 14px ${color}`,
                }}
              >
                {king ? `TURF KING · ${w.period ?? ""} · ${w.team_name}` : w.team_name}
                <span
                  className="mt-1 block font-display text-[9px] not-italic tracking-[0.14em] text-[#b7a079]"
                  style={{ transform: "rotate(2.5deg)", WebkitTextStroke: "0" }}
                >
                  {king
                    ? "Monthly belt — most weekly wins"
                    : `Week of ${w.week_start}${w.war_score != null ? ` · war ${Math.round(w.war_score)}` : ""}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
