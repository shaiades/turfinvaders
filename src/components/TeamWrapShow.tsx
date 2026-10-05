// The TEAM Daily Wrap cinematic — the crew's day as a post-match results reel:
// company sales from canvass, the Day MVP, the Van Wars champion (with every
// van's standing), and the top-3 podium celebration. Same tap-through format as
// the personal WrapShow, but aggregate-only — sales volume, sits and counts, no
// take-home pay and no customer PII — so anyone on the board can watch it.
// Reads useArcadeLadder (the same server aggregates the leaderboard uses).

import { useEffect, useMemo, useState } from "react";
import confetti from "canvas-confetti";
import { X, ChevronRight, RotateCcw } from "lucide-react";
import { RepAvatar } from "@/components/RepAvatar";
import { NeonButton } from "@/components/arcade";
import { ArcadeFxToggle } from "@/components/ArcadeFxToggle";
import { arcadeCue } from "@/lib/arcade-fx";
import { useRepCartoons, cartoonFor, type RepCartoon } from "@/hooks/useRepCartoons";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useArcadeLadder, type LadderRow, type VanRow } from "@/hooks/useCanvasserArcade";
import { sitRate } from "@/lib/canvasserPay";

export type WrapScope = "day" | "week" | "month";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const fmtVol = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;
const firstName = (name: string) => name.split(" ")[0];
const SCOPE_LABEL: Record<WrapScope, string> = {
  day: "TODAY",
  week: "THIS WEEK",
  month: "THIS MONTH",
};

function dateLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

/** Count 0 → `to` on mount (snaps under reduced motion). */
function CountUp({
  to,
  format,
  reduced,
}: {
  to: number;
  format: (n: number) => string;
  reduced: boolean;
}) {
  const [n, setN] = useState(reduced ? to : 0);
  useEffect(() => {
    if (reduced) {
      setN(to);
      return;
    }
    const start = performance.now();
    const dur = Math.min(1200, 400 + Math.abs(to) * 2);
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      setN(to * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [to, reduced]);
  return <>{format(n)}</>;
}

const KINDS = ["title", "company", "mvp", "vanwars", "podium"] as const;
type Kind = (typeof KINDS)[number];

type TeamData = {
  rows: LadderRow[];
  vans: VanRow[];
  companyVol: number;
  companySits: number;
  companyLeads: number;
  companySales: number;
  boardSize: number;
};

export function TeamWrapShow({ scope, onClose }: { scope: WrapScope; onClose: () => void }) {
  const ladder = useArcadeLadder(scope);
  const cartoons = useRepCartoons().data;
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);

  const data = useMemo<TeamData>(() => {
    const rows = ladder.rows;
    return {
      rows,
      vans: ladder.vans,
      companyVol: rows.reduce((a, r) => a + r.vol, 0),
      companySits: rows.reduce((a, r) => a + r.sit.sits, 0),
      companyLeads: rows.reduce((a, r) => a + r.sit.leads, 0),
      companySales: rows.reduce((a, r) => a + r.sal, 0),
      boardSize: rows.length,
    };
  }, [ladder.rows, ladder.vans]);

  const noScore = !ladder.loading && data.boardSize === 0;
  const kind: Kind = KINDS[i];

  useEffect(() => {
    if (ladder.loading || noScore || kind === "podium") return;
    const dur = kind === "title" ? 2600 : 3600;
    const t = setTimeout(() => setI((n) => Math.min(n + 1, KINDS.length - 1)), dur);
    return () => clearTimeout(t);
  }, [i, kind, ladder.loading, noScore]);

  useEffect(() => {
    if (ladder.loading) return;
    const fire = (colors: string[]) => {
      if (reduced) return;
      confetti({ particleCount: 120, spread: 80, startVelocity: 45, origin: { y: 0.55 }, colors });
    };
    if (kind === "company" && data.companyVol > 0) {
      fire(["#ffcf33", "#3be089", "#22e6ff"]);
      arcadeCue("coin", [20, 20]);
    } else if (kind === "mvp" && data.rows[0]) {
      fire(["#ffcf33", "#ff3d9a"]);
      arcadeCue("chest", [40, 30, 90]);
    } else if (kind === "vanwars" && data.vans.length > 0) {
      arcadeCue("rank", 25);
    } else if (kind === "podium" && data.rows.length > 0) {
      fire(["#ff3d9a", "#22e6ff", "#ffcf33"]);
      arcadeCue("levelup", [20, 20, 20]);
    }
  }, [kind, reduced, ladder.loading, data]);

  const next = () => setI((n) => Math.min(n + 1, KINDS.length - 1));
  const prev = () => setI((n) => Math.max(n - 1, 0));
  const anim = reduced ? "" : "wrap-in";

  return (
    <div className="fixed inset-0 z-[10025] flex flex-col bg-[linear-gradient(180deg,#0b0b12,#0a1420_60%,#0b0b12)] px-safe pt-safe pb-safe">
      {/* dots + fx + skip (above tap zones) */}
      <div className="relative z-20 flex items-center gap-1.5 px-4 pt-4">
        {KINDS.map((k, idx) => (
          <span
            key={k}
            className={`h-1 flex-1 rounded-full transition-colors ${
              idx <= i ? "bg-[var(--kombat-gold)]" : "bg-foreground/15"
            }`}
          />
        ))}
        <ArcadeFxToggle className="ml-1.5" />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close team wrap"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* tap zones */}
      <button
        type="button"
        aria-label="Previous"
        onClick={prev}
        className="absolute inset-y-0 left-0 z-10 w-1/4"
      />
      <button
        type="button"
        aria-label="Next"
        onClick={next}
        className="absolute inset-y-0 right-0 z-10 w-3/4"
      />

      {/* card */}
      <div className="relative z-0 flex flex-1 flex-col items-center justify-center px-6 text-center">
        {ladder.loading ? (
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Loading the crew's day…
          </p>
        ) : noScore ? (
          <div className={anim}>
            <p className="text-5xl" aria-hidden>
              🌙
            </p>
            <p className="mt-4 font-display text-sm uppercase tracking-widest text-[var(--kombat-gold)]">
              No crew scores {scope === "day" ? "today" : "yet"}
            </p>
          </div>
        ) : (
          <div key={i} className={`flex w-full max-w-sm flex-col items-center ${anim}`}>
            <TeamCard kind={kind} d={data} cartoons={cartoons} scope={scope} reduced={reduced} />
          </div>
        )}
      </div>

      {/* bottom controls (above tap zones) */}
      {!ladder.loading && (
        <div className="relative z-20 flex items-center justify-between gap-3 px-6 pb-4">
          <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            CREW · {SCOPE_LABEL[scope]}
          </span>
          {kind === "podium" || noScore ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setI(0)}
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Replay
              </button>
              <NeonButton onClick={onClose} tone="kombat-gold">
                Done
              </NeonButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={next}
              className="flex min-h-11 items-center gap-1 font-display text-[11px] uppercase tracking-widest text-[var(--kombat-gold)]"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TeamCard({
  kind,
  d,
  cartoons,
  scope,
  reduced,
}: {
  kind: Kind;
  d: TeamData;
  cartoons: Map<string, RepCartoon> | undefined;
  scope: WrapScope;
  reduced: boolean;
}) {
  switch (kind) {
    case "title": {
      const faces = d.rows.slice(0, 5);
      return (
        <>
          <div className="flex -space-x-3">
            {faces.map((r) => (
              <RepAvatar
                key={r.id}
                name={r.name}
                cartoon={cartoonFor(cartoons, r.name)}
                className="h-12 w-12 border-2 border-background"
                textClassName="text-[10px]"
              />
            ))}
          </div>
          <h2 className="mt-5 font-display text-2xl uppercase tracking-widest text-[var(--kombat-gold)]">
            Team Wrap
          </h2>
          <p className="mt-1 font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
            {dateLabel()} · {d.boardSize} on the board
          </p>
        </>
      );
    }
    case "company": {
      const rate = sitRate(d.companySits, d.companyLeads);
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Company sales from canvass
          </p>
          <p
            className="mt-2 font-display text-6xl tabular-nums text-victory"
            style={{ textShadow: "0 0 36px color-mix(in oklab, var(--victory) 45%, transparent)" }}
          >
            <CountUp to={d.companyVol} reduced={reduced} format={money} />
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            {d.companySits} sits
            {rate.grade ? ` · ${rate.grade} (${Math.round((rate.rate ?? 0) * 100)}%)` : ""} ·{" "}
            {d.companySales} sold
          </p>
        </>
      );
    }
    case "mvp": {
      const mvp = d.rows[0];
      if (!mvp) return <p className="text-sm text-muted-foreground">No MVP yet</p>;
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-[var(--kombat-gold)]">
            {scope === "day" ? "Day" : scope === "week" ? "Week" : "Month"} MVP
          </p>
          <span className="mt-2 text-2xl" aria-hidden>
            👑
          </span>
          <div
            className={`rounded-full ring-2 ring-[var(--kombat-gold)] ${reduced ? "" : "podium-glow"}`}
          >
            <RepAvatar
              name={mvp.name}
              cartoon={cartoonFor(cartoons, mvp.name)}
              variant="full"
              fit="contain"
              className="h-28 w-24"
            />
          </div>
          <p className="mt-3 font-display text-lg uppercase tracking-widest text-neon">
            {firstName(mvp.name)}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {fmtVol(mvp.vol)} · {mvp.sit.sits} sits
            {mvp.sit.grade ? ` · ${mvp.sit.grade}` : ""}
          </p>
        </>
      );
    }
    case "vanwars": {
      if (d.vans.length === 0)
        return <p className="text-sm text-muted-foreground">No vans on the board</p>;
      const champ = d.vans[0];
      const topPts = Math.max(1, ...d.vans.map((v) => v.pts));
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-[var(--kombat-gold)]">
            Van Wars Champion
          </p>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-2xl" aria-hidden>
              🏆
            </span>
            <span
              aria-hidden
              className="h-3 w-3 rounded-full"
              style={{ background: champ.color, boxShadow: `0 0 10px ${champ.color}` }}
            />
            <span className="font-display text-lg uppercase tracking-widest">{champ.name}</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {champ.pts} pts · {fmtVol(champ.vol)}
            {champ.sit.grade ? ` · ${champ.sit.grade}` : ""}
          </p>
          <ul className="mt-5 w-full space-y-2.5">
            {d.vans.map((v, idx) => (
              <li key={v.name}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="w-4 text-right font-display text-xs text-muted-foreground">
                      {idx + 1}
                    </span>
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: v.color }}
                    />
                    <span className="truncate">{v.name}</span>
                  </span>
                  <span className="shrink-0 font-display text-[11px] tabular-nums text-victory">
                    {v.pts} pts
                  </span>
                </div>
                <div className="mt-1 h-2 w-full overflow-hidden rounded-full border border-border bg-foreground/5">
                  <div
                    className="h-full rounded-full transition-[width] duration-700 ease-out"
                    style={{
                      width: `${(v.pts / topPts) * 100}%`,
                      background: `linear-gradient(90deg, color-mix(in oklab, ${v.color} 55%, transparent), ${v.color})`,
                      boxShadow: `0 0 10px ${v.color}`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </>
      );
    }
    case "podium": {
      // Visual order: #2 left, #1 center (tallest), #3 right.
      const top = d.rows.slice(0, 3);
      const order = [top[1], top[0], top[2]].filter(Boolean) as LadderRow[];
      const placeOf = (r: LadderRow) => top.indexOf(r) + 1;
      const ped: Record<number, string> = { 1: "h-20", 2: "h-14", 3: "h-10" };
      const medal: Record<number, string> = { 1: "👑", 2: "🥈", 3: "🥉" };
      const ring: Record<number, string> = {
        1: "ring-[var(--kombat-gold)]",
        2: "ring-[color-mix(in_oklab,white_55%,transparent)]",
        3: "ring-[var(--neon-orange)]",
      };
      return (
        <>
          <p className="mb-4 font-display text-xs uppercase tracking-widest text-neon">
            Top 3 · The Crew
          </p>
          <div className="grid w-full grid-cols-3 items-end gap-2">
            {order.map((r) => {
              const p = placeOf(r);
              return (
                <div key={r.id} className="flex min-w-0 flex-col items-center">
                  <span className="mb-1 text-lg leading-none" aria-hidden>
                    {medal[p]}
                  </span>
                  <div
                    className={`rounded-full ring-2 ${ring[p]} ${p === 1 && !reduced ? "podium-glow" : ""}`}
                  >
                    <RepAvatar
                      name={r.name}
                      cartoon={cartoonFor(cartoons, r.name)}
                      variant="full"
                      fit="contain"
                      className={p === 1 ? "h-16 w-16" : "h-12 w-12"}
                    />
                  </div>
                  <span className="mt-1.5 max-w-full truncate text-xs">{firstName(r.name)}</span>
                  <span className="font-display text-[11px] tabular-nums text-victory">
                    {fmtVol(r.vol)}
                  </span>
                  <div
                    className={`mt-1.5 w-full rounded-t-md border-x border-t border-border bg-[color-mix(in_oklab,var(--kombat-gold)_10%,transparent)] ${ped[p]}`}
                  >
                    <p className="pt-1 text-center font-display text-sm text-foreground/80">{p}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      );
    }
  }
}
