// The Daily Wrap cinematic — a Spotify-Wrapped-meets-results-screen sequence of
// tap-through cards with auto-advance, skip and replay, for Today / Week /
// Month. Every number comes from useWrapData (the pay engine + the same
// aggregates the board uses); no customer PII ever appears, here or on the
// share card. Reduced motion swaps the big moments for fades and snaps the
// count-ups, but keeps every number. Full-screen overlay; read-only.

import { useEffect, useState } from "react";
import confetti from "canvas-confetti";
import { X, ChevronRight, Share2, RotateCcw } from "lucide-react";
import { RepAvatar } from "@/components/RepAvatar";
import { NeonButton } from "@/components/arcade";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { useWrapData, type WrapScope } from "@/hooks/useWrapData";
import { BOSS_BOUNTY } from "@/lib/canvasserPay";
import { laTodayISO } from "@/lib/dates";
import { renderShareCard, shareOrDownloadCard } from "@/lib/share-card";

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;
const fmtVol = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n).toLocaleString()}`;
const SCOPE_LABEL: Record<WrapScope, string> = {
  day: "TODAY",
  week: "THIS WEEK",
  month: "THIS MONTH",
};
const GRADE_COLOR: Record<string, string> = {
  S: "var(--kombat-gold)",
  A: "var(--victory)",
  B: "var(--neon)",
  C: "var(--neon-orange)",
  D: "var(--muted-foreground)",
};

function dateLabel(): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date());
}

/** Count from 0 to `to` on mount (snaps if reduced motion). */
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
    const dur = Math.min(1100, 400 + Math.abs(to) * 2);
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

const KINDS = [
  "title",
  "leads",
  "sits",
  "sales",
  "boss",
  "earned",
  "rank",
  "badges",
  "tomorrow",
  "share",
] as const;
type Kind = (typeof KINDS)[number];

export function WrapShow({ scope, onClose }: { scope: WrapScope; onClose: () => void }) {
  const d = useWrapData(scope);
  const reduced = usePrefersReducedMotion();
  const [i, setI] = useState(0);
  const [saving, setSaving] = useState(false);
  const close = onClose;

  const noScore = !d.loading && d.leads === 0 && d.vol === 0 && d.pts === 0;
  const kind: Kind = KINDS[i];

  // Auto-advance (except the final share card). Re-armed each card.
  useEffect(() => {
    if (d.loading || noScore || kind === "share") return;
    const dur = kind === "title" ? 2600 : 3600;
    const t = setTimeout(() => setI((n) => Math.min(n + 1, KINDS.length - 1)), dur);
    return () => clearTimeout(t);
  }, [i, kind, d.loading, noScore]);

  // Celebratory bursts on the money / badge cards.
  useEffect(() => {
    if (reduced || d.loading) return;
    const fire = (colors: string[]) =>
      confetti({ particleCount: 110, spread: 75, startVelocity: 42, origin: { y: 0.55 }, colors });
    if (kind === "sales" && d.vol > 0) fire(["#ffcf33", "#3be089", "#22e6ff"]);
    if (kind === "boss" && d.boss.bossesDefeated > 0) fire(["#ffcf33", "#ff3d9a"]);
    if (kind === "badges" && d.badges.some((b) => b.unlocked))
      fire(["#ff3d9a", "#22e6ff", "#ffcf33"]);
  }, [kind, reduced, d.loading, d.vol, d.boss.bossesDefeated, d.badges]);

  const next = () => setI((n) => Math.min(n + 1, KINDS.length - 1));
  const prev = () => setI((n) => Math.max(n - 1, 0));

  const share = async () => {
    setSaving(true);
    try {
      const blob = await renderShareCard({
        name: d.name,
        scopeLabel: SCOPE_LABEL[scope],
        dateLabel: dateLabel(),
        rank: d.rank,
        sits: d.sits,
        sitRateLabel: d.sitRate.grade
          ? `${d.sitRate.grade} · ${Math.round((d.sitRate.rate ?? 0) * 100)}%`
          : "—",
        salesLabel: fmtVol(d.vol),
        bonusLabel: `Boss ${d.boss.level} · ${d.boss.bossesDefeated} 🧰`,
      });
      await shareOrDownloadCard(blob, `turf-invaders-${laTodayISO()}.png`);
    } catch {
      /* user cancelled or unsupported */
    } finally {
      setSaving(false);
    }
  };

  const anim = reduced ? "" : "wrap-in";

  return (
    <div className="fixed inset-0 z-[10025] flex flex-col bg-[linear-gradient(180deg,#0b0b12,#140a1e_60%,#0b0b12)] px-safe pt-safe pb-safe">
      {/* progress dots + skip */}
      <div className="flex items-center gap-1.5 px-4 pt-4">
        {KINDS.map((k, idx) => (
          <span
            key={k}
            className={`h-1 flex-1 rounded-full transition-colors ${
              idx <= i ? "bg-neon" : "bg-foreground/15"
            }`}
          />
        ))}
        <button
          type="button"
          onClick={close}
          aria-label="Close wrap"
          className="ml-2 grid h-9 w-9 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
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
        {d.loading ? (
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Loading your day…
          </p>
        ) : noScore ? (
          <div className={anim}>
            <p className="text-5xl" aria-hidden>
              🌙
            </p>
            <p className="mt-4 font-display text-sm uppercase tracking-widest text-neon">
              No scores {scope === "day" ? "today" : "yet"}
            </p>
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
              Clock in and knock — your wrap fills up as the results post.
            </p>
          </div>
        ) : (
          <div key={i} className={`flex w-full max-w-sm flex-col items-center ${anim}`}>
            <WrapCard kind={kind} d={d} reduced={reduced} saving={saving} onShare={share} />
          </div>
        )}
      </div>

      {/* bottom controls */}
      {!d.loading && (
        <div className="flex items-center justify-between gap-3 px-6 pb-4">
          <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            {SCOPE_LABEL[scope]}
          </span>
          {kind === "share" || noScore ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setI(0)}
                className="flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 font-display text-[10px] uppercase tracking-widest text-muted-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Replay
              </button>
              <NeonButton onClick={close} tone="turf-cyan">
                Done
              </NeonButton>
            </div>
          ) : (
            <button
              type="button"
              onClick={next}
              className="flex min-h-11 items-center gap-1 font-display text-[11px] uppercase tracking-widest text-neon"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function WrapCard({
  kind,
  d,
  reduced,
  saving,
  onShare,
}: {
  kind: Kind;
  d: ReturnType<typeof useWrapData>;
  reduced: boolean;
  saving: boolean;
  onShare: () => void;
}) {
  switch (kind) {
    case "title":
      return (
        <>
          <RepAvatar
            name={d.name}
            cartoon={d.cartoon}
            variant="full"
            fit="contain"
            rounded="lg"
            ring
            className="h-40 w-32"
          />
          <h2 className="mt-4 font-display text-lg uppercase tracking-widest text-neon">
            {d.name.split(" ")[0]}
          </h2>
          <p className="mt-1 font-display text-xs uppercase tracking-[0.3em] text-muted-foreground">
            {dateLabel()}
          </p>
          <p className="mt-6 font-display text-2xl uppercase tracking-widest text-foreground">
            Day Complete
          </p>
        </>
      );
    case "leads":
      return (
        <CardStat label="Leads set" color="var(--neon)">
          <CountUp to={d.leads} reduced={reduced} format={(n) => String(Math.round(n))} />
        </CardStat>
      );
    case "sits":
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Sit rate
          </p>
          <p
            className="mt-2 font-display text-[7rem] leading-none"
            style={{
              color: d.sitRate.grade ? GRADE_COLOR[d.sitRate.grade] : "var(--muted-foreground)",
              textShadow: d.sitRate.grade ? `0 0 40px ${GRADE_COLOR[d.sitRate.grade]}` : undefined,
            }}
          >
            {d.sitRate.grade ?? "—"}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {d.sits}/{d.sitRate.leads} leads sat
            {d.sitRate.rate != null ? ` · ${Math.round(d.sitRate.rate * 100)}%` : ""}
          </p>
        </>
      );
    case "sales":
      return (
        <CardStat label="Sales from your leads" color="var(--victory)">
          <CountUp to={d.vol} reduced={reduced} format={(n) => money(n)} />
        </CardStat>
      );
    case "boss":
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-[var(--kombat-gold)]">
            Boss {d.boss.level} · damage today
          </p>
          <p className="mt-2 font-display text-4xl tabular-nums text-[var(--kombat-red)]">
            <CountUp to={d.todayVol} reduced={reduced} format={(n) => money(n)} />
          </p>
          <BossDamageBar
            hpLeft={d.boss.hpLeft}
            hpMax={d.boss.hpMax}
            todayVol={d.todayVol}
            reduced={reduced}
          />
          <p className="mt-3 text-sm text-muted-foreground">
            {d.boss.bossesDefeated > 0 ? (
              <span className="text-[var(--kombat-gold)]">
                🧰 {d.boss.bossesDefeated} boss{d.boss.bossesDefeated === 1 ? "" : "es"} down ·{" "}
                {money(d.boss.bonusEarned)}
              </span>
            ) : (
              <>
                {money(d.boss.hpLeft)} to the next {money(BOSS_BOUNTY)}
              </>
            )}
          </p>
        </>
      );
    case "earned":
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Earned {d.scope === "month" ? "this month" : "this week"}
          </p>
          <p
            className="mt-2 font-display text-5xl text-victory tabular-nums"
            style={{ textShadow: "0 0 30px color-mix(in oklab, var(--victory) 45%, transparent)" }}
          >
            <CountUp to={d.earned} reduced={reduced} format={(n) => money(n)} />
          </p>
          <ul className="mt-5 w-full space-y-1.5">
            {d.loot
              .filter((l) => l.amount > 0)
              .map((l) => (
                <li key={l.kind} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{l.label}</span>
                  <span className="font-display tabular-nums">{money(l.amount)}</span>
                </li>
              ))}
          </ul>
        </>
      );
    case "rank": {
      const start = d.morningRank ?? d.boardSize;
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Your rank
          </p>
          <p className="mt-2 font-display text-[6rem] leading-none text-neon">
            #
            <CountUp to={d.rank ?? start} reduced={reduced} format={(n) => String(Math.round(n))} />
          </p>
          {d.morningRank != null && d.rank != null && d.morningRank !== d.rank && (
            <p
              className={`mt-2 font-display text-sm uppercase tracking-widest ${
                d.rank < d.morningRank ? "text-victory" : "text-destructive"
              }`}
            >
              {d.rank < d.morningRank ? "▲" : "▼"} from #{d.morningRank} this morning
            </p>
          )}
          <p className="mt-1 text-sm text-muted-foreground">of {d.boardSize} on the board</p>
        </>
      );
    }
    case "badges":
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Level {d.level.level} · {d.level.title}
          </p>
          <div className="mt-3 h-3 w-full overflow-hidden rounded-full border border-border bg-foreground/5">
            <div
              className="h-full rounded-full bg-neon transition-[width] duration-1000 ease-out"
              style={{ width: `${d.level.pct * 100}%`, boxShadow: "0 0 12px var(--neon)" }}
            />
          </div>
          <p className="mt-1.5 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
            +{d.xpEarned} XP
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {d.badges.map((b) => (
              <span
                key={b.def.id}
                title={b.def.blurb}
                className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${
                  b.unlocked
                    ? "border-[var(--kombat-gold)] text-foreground"
                    : "border-border text-muted-foreground/40"
                }`}
              >
                <span aria-hidden className={b.unlocked ? "" : "grayscale"}>
                  {b.def.icon}
                </span>
                {b.def.label}
              </span>
            ))}
          </div>
        </>
      );
    case "tomorrow":
      return (
        <>
          <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
            Tomorrow&apos;s mission
          </p>
          <ul className="mt-4 space-y-3 text-left">
            <li className="flex items-start gap-2">
              <span aria-hidden>🎯</span>
              <span className="text-sm">
                <span className="text-[var(--kombat-gold)]">{money(d.boss.hpLeft)}</span> to the
                next {money(BOSS_BOUNTY)} bonus
              </span>
            </li>
            {d.sitRate.rate != null && (
              <li className="flex items-start gap-2">
                <span aria-hidden>📈</span>
                <span className="text-sm">
                  Beat your {Math.round(d.sitRate.rate * 100)}% sit rate
                </span>
              </li>
            )}
            {d.ahead && (
              <li className="flex items-start gap-2">
                <span aria-hidden>⚔️</span>
                <span className="text-sm">
                  {fmtVol(Math.max(0, d.ahead.gapVol))} to pass {d.ahead.name.split(" ")[0]}
                </span>
              </li>
            )}
          </ul>
        </>
      );
    case "share":
      return (
        <>
          <p className="font-display text-sm uppercase tracking-widest text-neon">Share your day</p>
          {/* Preview */}
          <div className="mt-4 w-48 rounded-2xl border border-neon/40 bg-[#0b0b12] p-4 shadow-[0_0_30px_-8px_var(--neon)]">
            <RepAvatar
              name={d.name}
              cartoon={d.cartoon}
              className="mx-auto h-14 w-14"
              ring
              textClassName="text-sm"
            />
            <p className="mt-2 truncate font-display text-xs uppercase tracking-widest text-foreground">
              {d.name.split(" ")[0]}
            </p>
            {d.rank != null && (
              <p className="font-display text-[10px] uppercase tracking-widest text-[var(--kombat-gold)]">
                Rank #{d.rank}
              </p>
            )}
            <div className="mt-2 grid grid-cols-2 gap-1 text-[10px]">
              <Mini label="Sits" value={String(d.sits)} />
              <Mini label="Rate" value={d.sitRate.grade ?? "—"} />
              <Mini label="Sales" value={fmtVol(d.vol)} />
              <Mini label="Bonus" value={`🧰${d.boss.bossesDefeated}`} />
            </div>
          </div>
          <button
            type="button"
            onClick={onShare}
            disabled={saving}
            className="mt-5 flex min-h-11 items-center gap-2 rounded-lg bg-neon px-4 font-display text-[11px] uppercase tracking-widest text-neon-foreground disabled:opacity-60"
          >
            <Share2 className="h-4 w-4" /> {saving ? "Saving…" : "Save / Share"}
          </button>
          <p className="mt-2 text-[10px] text-muted-foreground">No customer info on the card.</p>
        </>
      );
  }
}

function CardStat({
  label,
  color,
  children,
}: {
  label: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <p className="font-display text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p
        className="mt-2 font-display text-6xl tabular-nums"
        style={{ color, textShadow: `0 0 36px color-mix(in oklab, ${color} 45%, transparent)` }}
      >
        {children}
      </p>
    </>
  );
}

/** Boss health bar that starts at today's pre-damage HP and chips down to the
 *  real remaining HP — the visible "hit". Snaps under reduced motion. */
function BossDamageBar({
  hpLeft,
  hpMax,
  todayVol,
  reduced,
}: {
  hpLeft: number;
  hpMax: number;
  todayVol: number;
  reduced: boolean;
}) {
  const before = Math.min(hpMax, hpLeft + todayVol);
  const [pct, setPct] = useState(reduced ? hpLeft / hpMax : before / hpMax);
  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => setPct(hpLeft / hpMax), 420);
    return () => clearTimeout(t);
  }, [hpLeft, hpMax, reduced]);
  return (
    <div className="mt-5 h-5 w-full overflow-hidden rounded-md border border-border bg-foreground/5">
      <div
        className="h-full rounded-[3px] transition-[width] duration-[1100ms] ease-out"
        style={{
          width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
          background:
            "linear-gradient(90deg, color-mix(in oklab, var(--kombat-red) 55%, transparent), var(--kombat-red))",
          boxShadow: "0 0 16px var(--kombat-red)",
        }}
      />
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 py-1">
      <p className="text-muted-foreground/70">{label}</p>
      <p className="font-display text-foreground">{value}</p>
    </div>
  );
}
