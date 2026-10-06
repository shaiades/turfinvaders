// Van Wars — the weekly street race (§3), Grand Theft Auto skin (owner, 2026-10-05):
// Vice City neon, a Pricedown-style heavy title, GTA cash-green crew banks,
// wanted-level heat stars, angled character-select crew cards, and the iconic
// WASTED stamp on the crew that just lost #1. Crews still RACE down the strip —
// a van's position is its war score (points per active knocker, config-
// switchable; sit 1 / sale 2) — lurching with a nitrous burst when a crew
// surges and sparking on a sale, with a full-width "TOOK THE BLOCK" lead-change
// banner (hiss + haptic). Reduced motion drops the strip for the static cards.
// Vans race under their CAPTAIN's name. Numbers ride useVanWars → the week
// ladder the Solo board uses. The Wall / Trophy case reads vanwars_wins (dark
// until the migration + Saturday crowning land). Captains fire one callout a day.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useVanWars, type VanWarWin } from "@/hooks/useVanWars";
import { ArcadeCard, ArcadeSkeleton } from "@/components/arcade";
import { playArcadeSound, haptic } from "@/lib/arcade-fx";
import { laTodayISO } from "@/lib/dates";

const CASH = "#9bf00b";
const WANTED = "#ffd23d";
const WASTED = "#ff2b3d";
const GTA = "'Arial Black', Impact, 'Franklin Gothic Heavy', sans-serif";

const fmtCash = (n: number) =>
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

/** Leader "heat" — more crews chasing = hotter. Flavor, 1–5 stars. */
function WantedStars({ n }: { n: number }) {
  const filled = Math.max(1, Math.min(5, n));
  return (
    <span aria-hidden style={{ letterSpacing: 2, fontSize: 15 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          style={{
            color: i < filled ? WANTED : "#3a2b4a",
            textShadow: i < filled ? `0 0 8px ${WANTED}, 0 0 1px #000` : "none",
          }}
        >
          ★
        </span>
      ))}
    </span>
  );
}

export function VanWarsRace() {
  const { user, realRole } = useAuth();
  const reduced = usePrefersReducedMotion();
  const { standings, leader, config, wins, loading } = useVanWars();

  // ── Live events: per-crew surge (war up = nitro, $ up = sparks) + a change
  // of leader (the TOOK-THE-BLOCK banner + the WASTED stamp on the loser).
  const prevWar = useRef(new Map<string, number>());
  const prevVol = useRef(new Map<string, number>());
  const prevLeader = useRef<string | null>(null);
  const seeded = useRef(false);
  const [surge, setSurge] = useState<Record<string, "war" | "sale">>({});
  const [wasted, setWasted] = useState<string | null>(null);
  const [spray, setSpray] = useState<{ title: string; color: string; sub: string } | null>(null);
  const sprayTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const surgeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fireSpray = (title: string, color: string, sub: string) => {
    setSpray({ title, color, sub });
    playArcadeSound("spray");
    haptic([30, 40, 30]);
    clearTimeout(sprayTimer.current);
    sprayTimer.current = setTimeout(() => {
      setSpray(null);
      setWasted(null);
    }, 2800);
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
        setWasted(prevLeader.current);
        fireSpray(`${lead}'S CREW TOOK THE BLOCK`, standings[0].color, "New #1 on the strip");
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

  // ── Captain callout: one preset a day, at the leader.
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

  const leaderWar = standings.length ? Math.max(1e-6, standings[0].war) : 1;
  const posPct = useMemo(
    () => (w: number) => Math.min(88, Math.max(24, 30 + (w / leaderWar) * 56)),
    [leaderWar],
  );

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

  return (
    <div className="space-y-4">
      {/* ── GTA title ─────────────────────────────────────────────────── */}
      <div className="text-center">
        <div
          style={{
            fontFamily: GTA,
            fontStyle: "italic",
            fontSize: 44,
            lineHeight: 0.85,
            color: "#fff",
            letterSpacing: "0.01em",
            WebkitTextStroke: "2.5px #0a0712",
            textShadow: "4px 4px 0 rgba(255,46,154,.55), 7px 7px 0 rgba(0,0,0,.4)",
          }}
        >
          VAN WARS
        </div>
        <div
          className="mt-1 font-display text-[9px] uppercase tracking-[0.26em] text-[color:var(--pink,#ff2e9a)]"
          style={{ color: "#ff5cb4" }}
        >
          This week · crowned Saturday 6 PM
        </div>
      </div>

      {/* ── Heat + top-crew bank HUD ──────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-display text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
            Heat · {standings[0].name}
          </div>
          <WantedStars n={standings.length} />
        </div>
        <div className="text-right">
          <div className="font-display text-[8px] uppercase tracking-[0.2em] text-muted-foreground">
            Top crew bank
          </div>
          <div
            style={{
              fontFamily: GTA,
              fontSize: 22,
              color: CASH,
              textShadow: "0 2px 0 #1f3d00, 0 0 14px rgba(155,240,11,.35)",
            }}
          >
            {fmtCash(standings[0].vol)}
          </div>
        </div>
      </div>

      {/* ── The race strip (motion only) ─────────────────────────────── */}
      {!reduced && (
        <div
          className="relative overflow-hidden rounded-2xl border"
          style={{
            borderColor: "rgba(255,120,220,.22)",
            background: "linear-gradient(180deg,#160a24 0%,#12091f 45%,#07040f 100%)",
          }}
        >
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24"
            style={{
              background:
                "radial-gradient(500px 120px at 78% 40%, rgba(255,46,154,.22), transparent 70%),radial-gradient(420px 120px at 18% 60%, rgba(25,227,255,.16), transparent 70%)",
            }}
          />
          <div className="relative z-10 flex flex-col gap-0.5 px-1 py-2">
            {standings.map((v, i) => {
              const isLeader = i === 0;
              const ev = surge[v.name];
              return (
                <div key={v.name} className="relative h-12">
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
                          fill={WANTED}
                          stroke="#6b4e00"
                          strokeWidth="1"
                        />
                      </svg>
                    )}
                    <span
                      style={{
                        fontFamily: GTA,
                        fontStyle: "italic",
                        fontSize: 12,
                        lineHeight: 0.9,
                        color: v.color,
                        WebkitTextStroke: "1px rgba(2,6,14,.85)",
                        textShadow: `0 0 10px ${v.color}`,
                      }}
                    >
                      {v.name}
                    </span>
                    <div className="relative">
                      <span
                        aria-hidden
                        className="vw-streak absolute right-[58%] top-[46%] h-0.5 w-16 rounded"
                        style={{ background: `linear-gradient(90deg,transparent,${v.color})` }}
                      />
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
                      <span
                        aria-hidden
                        className="absolute -bottom-0.5 left-1/2 h-3 w-20 -translate-x-1/2 rounded-full"
                        style={{ background: v.color, filter: "blur(5px)", opacity: 0.8 }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(130% 90% at 50% 40%, transparent 55%, rgba(0,0,0,.6) 100%)",
            }}
          />
          {spray && (
            <div
              className="vw-spray-in absolute inset-x-3 bottom-3 z-20 rounded-xl p-3"
              style={{
                borderLeft: `5px solid ${spray.color}`,
                background: `linear-gradient(90deg, color-mix(in oklab, ${spray.color} 22%, transparent), rgba(8,4,16,.92) 62%)`,
                boxShadow: `0 10px 30px -14px ${spray.color}`,
              }}
            >
              <div
                style={{
                  fontFamily: GTA,
                  fontStyle: "italic",
                  fontSize: 20,
                  color: "#fff",
                  textShadow: `0 0 18px ${spray.color}`,
                }}
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

      {/* ── Standings — GTA character-select cards ────────────────────── */}
      <div className="space-y-2">
        {standings.map((v, i) => {
          const isLeader = i === 0;
          return (
            <div
              key={v.name}
              className="relative overflow-hidden border-2"
              style={{
                transform: "skewX(-8deg)",
                borderColor: isLeader ? "rgba(255,210,61,.6)" : "rgba(255,255,255,.1)",
                background: "linear-gradient(90deg,rgba(255,255,255,.04),transparent)",
                boxShadow: isLeader ? `0 0 22px -8px ${WANTED}` : "none",
              }}
            >
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[7px]"
                style={{ background: v.color, boxShadow: `0 0 12px ${v.color}` }}
              />
              <div
                className="flex items-center gap-3 px-4 py-2.5"
                style={{ transform: "skewX(8deg)" }}
              >
                <span
                  style={{
                    fontFamily: GTA,
                    fontSize: 24,
                    width: 22,
                    textAlign: "center",
                    color: isLeader ? WANTED : "var(--muted-foreground)",
                  }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate"
                    style={{
                      fontFamily: GTA,
                      fontStyle: "italic",
                      fontSize: 20,
                      lineHeight: 0.9,
                      color: v.color,
                    }}
                  >
                    {v.name}
                  </div>
                  <div className="mt-0.5 font-display text-[9px] uppercase tracking-wide text-muted-foreground">
                    {v.pts} pts · {v.knockers} {v.knockers === 1 ? "knocker" : "knockers"} ·{" "}
                    <span style={{ color: CASH }}>{v.vol > 0 ? fmtCash(v.vol) : "desk"}</span>
                  </div>
                </div>
                <div className="text-right">
                  <div style={{ fontFamily: GTA, fontSize: 26, lineHeight: 1, color: v.color }}>
                    {Math.round(v.war)}
                  </div>
                  <div className="font-display text-[7px] uppercase tracking-[0.2em] text-muted-foreground">
                    War / head
                  </div>
                </div>
                {v.sit.grade && (
                  <span
                    style={{
                      fontFamily: GTA,
                      fontSize: 18,
                      width: 24,
                      textAlign: "center",
                      borderRadius: 4,
                      color: "#0b0f18",
                      background: v.color,
                    }}
                  >
                    {v.sit.grade}
                  </span>
                )}
              </div>
              {wasted === v.name && (
                <div
                  className="vw-wasted absolute inset-0 flex items-center justify-center"
                  style={{ background: "rgba(6,3,10,.62)", transform: "skewX(8deg)" }}
                >
                  <span
                    style={{
                      fontFamily: GTA,
                      fontStyle: "italic",
                      fontSize: 26,
                      color: WASTED,
                      letterSpacing: "0.04em",
                      WebkitTextStroke: "2px #2a0007",
                      textShadow: `0 0 18px ${WASTED}`,
                    }}
                  >
                    WASTED
                  </span>
                </div>
              )}
            </div>
          );
        })}
        <p className="font-display text-[10px] leading-relaxed text-muted-foreground">
          War score = points per active knocker, so a small crew can still jack #1. Ties break on
          sit rate.
        </p>
      </div>

      {/* ── Captain callout ───────────────────────────────────────────── */}
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
                className="min-h-11 flex-1 border-2 px-3 py-2 disabled:opacity-40 md:min-h-0"
                style={{
                  transform: "skewX(-8deg)",
                  color: "#ffa6d6",
                  borderColor: "rgba(255,46,154,.5)",
                  background: "rgba(255,46,154,.12)",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    transform: "skewX(8deg)",
                    fontFamily: GTA,
                    fontStyle: "italic",
                    fontSize: 13,
                  }}
                >
                  {c}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Trophy case (Wall of Fame) ────────────────────────────────── */}
      <TrophyCase wins={wins} />
    </div>
  );
}

function TrophyCase({ wins }: { wins: VanWarWin[] }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-4"
      style={{
        border: `2px solid rgba(255,210,61,.3)`,
        background:
          "linear-gradient(180deg,rgba(0,0,0,.45),rgba(0,0,0,.65)),repeating-linear-gradient(90deg,#1a1024 0 2px,#140d1d 2px 5px)",
      }}
    >
      <div
        className="mb-3 font-display text-[10px] uppercase tracking-[0.24em]"
        style={{ color: "#ffcf7a" }}
      >
        ★ Trophy case — most wanted
      </div>
      {wins.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No crews tagged yet — the first weekly champ gets mounted here after Saturday's 6 PM
          crowning.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {wins.map((w, i) => {
            const king = w.kind === "king";
            const color = w.color ?? WANTED;
            return (
              <div key={`${w.week_start}-${w.kind}-${i}`} className="flex items-center gap-3">
                <span className="w-16 font-display text-[9px] uppercase tracking-wide text-muted-foreground">
                  {king ? "Turf King" : `Wk ${w.week_start.slice(5)}`}
                </span>
                <span
                  style={{
                    fontFamily: GTA,
                    fontStyle: "italic",
                    fontSize: 18,
                    color: king ? WANTED : color,
                    textShadow: king ? `0 0 16px rgba(255,210,61,.6)` : `0 0 10px ${color}`,
                  }}
                >
                  {w.team_name}
                  {king && w.period ? ` · ${w.period}` : ""}
                  {!king && w.war_score != null ? ` · war ${Math.round(w.war_score)}` : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
