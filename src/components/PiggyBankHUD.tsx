import { memo, useCallback, useEffect, useRef, useState } from "react";
import { PiggyBank as PiggyBankIcon } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { clamp01, drawCoin, easeInOut, makeBeeper, popText } from "./intro-fx";

/**
 * The door-knock piggy bank: every knock arcs a coin into the pig and ticks
 * the PROJECTED dollars banked today (knocks × expected value per door —
 * usePiggyBank owns the math). Projected only, never payroll — the word
 * "projected" is load-bearing on every surface because this app cuts real
 * paychecks elsewhere.
 *
 * Two registers: "map" is the compact pill overlaying the Active Run map
 * (kept narrow — the NeonMap "Dropping:" legend owns the opposite corner on
 * 375px phones); "card" is the Mission → Stats panel. All animation state
 * lives in refs and the rAF loop hard-stops when nothing is in flight —
 * Active Run re-renders on every GPS tick and reps run on battery.
 */

type Variant = "map" | "card";

/** Display bucket only — the pig visibly refills every $100 banked. Not a
 *  goal and not a reported figure. */
const FILL_STEP = 100;

type Geo = {
  w: number;
  h: number;
  /** canvas offset from the pill/card content origin */
  left: number;
  top: number;
  pig: { x: number; y: number };
  spawn: { x: number; y: number };
  ctrl: { x: number; y: number };
  float: { x: number; y: number };
  coinR: number;
};

// Coins rise from lower-right INTO the pig at upper-left, so the canvas only
// extends right/below the pill — never above the map's top edge.
const GEO: Record<Variant, Geo> = {
  map: {
    w: 220,
    h: 170,
    left: -10,
    top: -6,
    pig: { x: 30, y: 26 },
    spawn: { x: 192, y: 150 },
    ctrl: { x: 168, y: 8 },
    float: { x: 74, y: 96 }, // below the pill, over open map — clear of the legend
    coinR: 6.5,
  },
  card: {
    w: 280,
    h: 150,
    left: 0,
    top: 0,
    pig: { x: 48, y: 48 },
    spawn: { x: 252, y: 132 },
    ctrl: { x: 210, y: 4 },
    float: { x: 56, y: 46 }, // pops off the pig, clear of label and ticker
    coinR: 7.5,
  },
};

const fmtCents = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Whole dollars, compacted past $10K so the map pill can never crowd the
 *  NeonMap "Dropping:" legend on a 375px phone. */
const fmtBank = (n: number) =>
  n >= 10_000 ? `$${Math.round(n / 1000)}K` : formatCurrency(Math.round(n));

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/** LiveLeadCounter's tick, minus the digit tiles — one text run. */
function useCountUp(value: number, instant: boolean) {
  const [display, setDisplay] = useState(value);
  const [bump, setBump] = useState(false);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    if (from === to) return;
    prevRef.current = to;
    if (instant) {
      setDisplay(to);
      return;
    }
    const start = performance.now();
    const duration = Math.min(800, 120 + Math.abs(to - from) * 18);
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    if (to > from) {
      setBump(true);
      const id = window.setTimeout(() => setBump(false), 320);
      return () => {
        cancelAnimationFrame(raf);
        window.clearTimeout(id);
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [value, instant]);
  return { display, bump };
}

function PigFill({
  pct,
  bump,
  flare,
  reduced,
  className,
}: {
  pct: number;
  bump: boolean;
  flare: boolean;
  reduced: boolean;
  className?: string;
}) {
  const inset = `inset(${((1 - clamp01(pct)) * 100).toFixed(1)}% 0 0 0)`;
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block shrink-0",
        !reduced && "transition-transform duration-200",
        bump && !reduced && "scale-110",
        className,
      )}
    >
      <PiggyBankIcon className="h-full w-full text-victory/25" />
      <span
        className="absolute inset-0"
        style={{ clipPath: inset, transition: reduced ? "none" : "clip-path 600ms ease-out" }}
      >
        <PiggyBankIcon
          className="h-full w-full text-victory"
          style={{
            // Kept subtle — heavy stacked blurs bloom into a blob that the
            // clip-path then crops into a hard-edged block.
            filter: flare
              ? "drop-shadow(0 0 5px var(--victory)) drop-shadow(0 0 12px var(--victory))"
              : "drop-shadow(0 0 4px color-mix(in oklab, var(--victory) 55%, transparent))",
          }}
        />
      </span>
    </span>
  );
}

type FlightCoin = { born: number; size: number; dollars: number; drift: number };
type Floater = { born: number; dollars: number };

export const PiggyBankHUD = memo(function PiggyBankHUD({
  dollars,
  perKnock,
  knocks,
  paceKnocks = null,
  source = "company",
  variant = "map",
  demo = false,
  demoRateMs,
  className,
}: {
  dollars: number | null;
  perKnock: number | null;
  knocks: number;
  /** Knocks still needed this week to stay on income-goal pace. */
  paceKnocks?: number | null;
  source?: "personal" | "company";
  variant?: Variant;
  /** Preview driver (?piggy_demo=1) — fakes knocks locally, writes nothing. */
  demo?: boolean;
  demoRateMs?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const g = GEO[variant];

  // Demo mode replaces the feed entirely so previews never mix with (or
  // touch) real state.
  const [demoState, setDemoState] = useState({ knocks: 0, dollars: 0 });
  const demoPer = perKnock ?? 8;
  useEffect(() => {
    if (!demo) return;
    const id = window.setInterval(
      () => setDemoState((s) => ({ knocks: s.knocks + 1, dollars: s.dollars + demoPer })),
      demoRateMs ?? 1600,
    );
    return () => window.clearInterval(id);
  }, [demo, demoRateMs, demoPer]);

  const kn = demo ? demoState.knocks : knocks;
  const dl = demo ? demoState.dollars : dollars;
  const perKnockEff = demo ? demoPer : perKnock;

  // ── Animation core: refs only, loop self-terminates when empty ────────
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dprRef = useRef(1);
  const coinsRef = useRef<FlightCoin[]>([]);
  const queueRef = useRef<{ size: number; dollars: number; drift: number }[]>([]);
  const floatersRef = useRef<Floater[]>([]);
  const lastLaunchRef = useRef(0);
  const lastBeepRef = useRef(0);
  const runningRef = useRef(false);
  const rafRef = useRef(0);
  const beepRef = useRef<ReturnType<typeof makeBeeper> | null>(null);

  const [pigBump, setPigBump] = useState(false);
  const [flare, setFlare] = useState(false);
  const [caption, setCaption] = useState(false);

  useEffect(() => {
    if (reduced) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    dprRef.current = dpr;
    canvas.width = g.w * dpr;
    canvas.height = g.h * dpr;
  }, [g, reduced]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const loopRef = useRef<(now: number) => void>(() => {});
  loopRef.current = (now: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      runningRef.current = false;
      return;
    }
    if (queueRef.current.length && now - lastLaunchRef.current >= 90) {
      const q = queueRef.current.shift()!;
      coinsRef.current.push({ born: now, size: q.size, dollars: q.dollars, drift: q.drift });
      lastLaunchRef.current = now;
    }
    ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
    ctx.clearRect(0, 0, g.w, g.h);

    for (let i = coinsRef.current.length - 1; i >= 0; i--) {
      const c = coinsRef.current[i];
      const t = (now - c.born) / 550;
      if (t >= 1) {
        coinsRef.current.splice(i, 1);
        // Swallowed: pig gulps, the burst's floater absorbs the value, and
        // the two-note ka-ching fires at most every 400ms.
        setPigBump(true);
        window.setTimeout(() => setPigBump(false), 200);
        if (c.dollars > 0) {
          const last = floatersRef.current[floatersRef.current.length - 1];
          if (last && now - last.born < 400) last.dollars += c.dollars;
          else floatersRef.current.push({ born: now, dollars: c.dollars });
        }
        if (now - lastBeepRef.current > 400) {
          lastBeepRef.current = now;
          beepRef.current ??= makeBeeper();
          beepRef.current(1318, 70, 0, "sine");
          beepRef.current(1760, 260, 80, "sine");
        }
        continue;
      }
      const p = easeInOut(clamp01(t));
      const mt = 1 - p;
      const x = mt * mt * c.drift + 2 * mt * p * g.ctrl.x + p * p * g.pig.x;
      const y = mt * mt * g.spawn.y + 2 * mt * p * g.ctrl.y + p * p * g.pig.y;
      const swallow = t > 0.85 ? 1 - (t - 0.85) / 0.15 : 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((now - c.born) / 140);
      ctx.scale(swallow, swallow);
      drawCoin(ctx, c.size);
      ctx.restore();
    }

    for (let i = floatersRef.current.length - 1; i >= 0; i--) {
      const f = floatersRef.current[i];
      const age = now - f.born;
      if (age > 750) {
        floatersRef.current.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = 1 - clamp01((age - 320) / 430);
      popText(
        ctx,
        `+${fmtCents(f.dollars)}`,
        g.float.x,
        g.float.y - (age / 750) * 22,
        f.born,
        now,
        15,
        "#ffe27a",
        "#ffb02a",
      );
      ctx.restore();
    }

    if (coinsRef.current.length || queueRef.current.length || floatersRef.current.length) {
      rafRef.current = requestAnimationFrame((n) => loopRef.current(n));
    } else {
      ctx.clearRect(0, 0, g.w, g.h);
      runningRef.current = false;
    }
  };

  const ensureLoop = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    rafRef.current = requestAnimationFrame((n) => loopRef.current(n));
  }, []);

  const enqueueCoins = useCallback(
    (count: number, totalDollars: number) => {
      if (reduced) return;
      // Rapid taps coalesce: at most 5 coins per burst (extras fatten the
      // last one) and a bounded queue overall.
      const n = Math.max(1, Math.min(count, 5));
      const each = totalDollars / n;
      for (let i = 0; i < n; i++) {
        const fat = i === n - 1 && count > n;
        const coin = {
          size: g.coinR * (fat ? Math.min(2, 1 + (count - n) * 0.25) : 1),
          dollars: each,
          drift: g.spawn.x + (Math.random() - 0.5) * 26,
        };
        const tail = queueRef.current[queueRef.current.length - 1];
        if (queueRef.current.length >= 10 && tail) {
          tail.dollars += coin.dollars;
          tail.size = Math.min(g.coinR * 2, tail.size * 1.15);
        } else {
          queueRef.current.push(coin);
        }
      }
      ensureLoop();
    },
    [g, reduced, ensureLoop],
  );

  // Knock watcher — the optimistic pin lands in cache the same frame as the
  // haptic, so this effect IS the knock event. Decreases (pin deleted)
  // animate nothing; the ticker and fill just settle down.
  const prevKnocksRef = useRef(kn);
  useEffect(() => {
    const delta = kn - prevKnocksRef.current;
    prevKnocksRef.current = kn;
    if (delta <= 0) return;
    enqueueCoins(delta, perKnockEff !== null ? delta * perKnockEff : 0);
  }, [kn, perKnockEff, enqueueCoins]);

  // $100 bucket rollover → one-time flare + a small coin fountain.
  const prevBucketRef = useRef<number | null>(null);
  useEffect(() => {
    if (dl === null) return;
    const bucket = Math.floor(dl / FILL_STEP);
    const prev = prevBucketRef.current;
    prevBucketRef.current = bucket;
    if (prev !== null && bucket > prev && !reduced) {
      setFlare(true);
      const id = window.setTimeout(() => setFlare(false), 900);
      enqueueCoins(6, 0);
      return () => window.clearTimeout(id);
    }
  }, [dl, reduced, enqueueCoins]);

  const { display: displayDollars, bump: tickBump } = useCountUp(dl ?? 0, reduced);

  // Screen-reader narration, debounced so a knocking streak reads once.
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => {
      setLiveText(
        dl !== null
          ? `Projected today: ${formatCurrency(Math.round(dl))} from ${kn} doors`
          : `${kn} doors knocked today`,
      );
    }, 4000);
    return () => window.clearTimeout(id);
  }, [dl, kn]);

  const fill = dl === null ? 1 : (((dl % FILL_STEP) + FILL_STEP) % FILL_STEP) / FILL_STEP;
  const ariaLabel =
    dl !== null
      ? `Projected today: ${formatCurrency(Math.round(dl))} from ${kn} doors`
      : `${kn} doors knocked today`;

  const onTap = () => {
    if (demo) {
      setDemoState((s) => ({ knocks: s.knocks + 1, dollars: s.dollars + demoPer }));
      return;
    }
    setCaption(true);
    window.setTimeout(() => setCaption(false), 2000);
    enqueueCoins(1, 0);
  };

  const canvasEl = !reduced && (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute z-[1001]"
      style={{ left: g.left, top: g.top, width: g.w, height: g.h }}
    />
  );

  if (variant === "card") {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-xl border border-victory/40 bg-[color-mix(in_oklab,var(--victory)_8%,var(--surface))] p-5",
          className,
        )}
      >
        {canvasEl}
        <div className="flex items-center gap-4">
          <PigFill pct={fill} bump={pigBump} flare={flare} reduced={reduced} className="h-14 w-14" />
          <div className="min-w-0">
            <div className="text-[9px] font-display uppercase tracking-[0.2em] text-muted-foreground">
              Piggy Bank · Projected
            </div>
            <div
              className={cn(
                "mt-1.5 font-display text-3xl text-victory tabular-nums leading-none",
                tickBump && !reduced && "transition-transform duration-200 scale-105",
              )}
              style={{ textShadow: "0 0 12px var(--victory)" }}
            >
              {dl !== null ? fmtBank(displayDollars) : `${kn} doors`}
            </div>
            <div className="mt-1.5 text-xs text-muted-foreground">
              {dl !== null && perKnockEff !== null
                ? `${kn} doors × ${fmtCents(perKnockEff)} projected per knock · ${
                    source === "personal" ? "your 60-day rates" : "company averages"
                  }`
                : "Awaiting conversion data — doors still bank"}
            </div>
          </div>
        </div>
        <span className="sr-only" aria-live="polite">
          {liveText}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("relative", className)}>
      {canvasEl}
      <button
        type="button"
        onClick={onTap}
        aria-label={ariaLabel}
        className="relative z-[1002] flex h-11 items-center gap-1.5 rounded-full border border-victory/50 bg-surface/90 px-2.5 backdrop-blur"
      >
        <PigFill pct={fill} bump={pigBump} flare={flare} reduced={reduced} className="h-5 w-5" />
        <span
          className={cn(
            "font-display text-[10px] text-victory tabular-nums",
            tickBump && !reduced && "transition-transform duration-200 scale-105",
          )}
          style={{ textShadow: "0 0 10px var(--victory)" }}
        >
          {dl !== null ? fmtBank(displayDollars) : kn}
        </span>
      </button>
      {caption && (
        <div className="absolute top-full left-0 z-[1002] mt-1 whitespace-nowrap rounded-md border border-border bg-surface/95 px-2 py-1 font-display text-[9px] uppercase tracking-widest text-muted-foreground">
          {dl !== null && perKnockEff !== null
            ? `${kn} doors · ${formatCurrency(Math.round(dl))} projected`
            : `${kn} doors · awaiting rate data`}
          {paceKnocks !== null && paceKnocks > 0 && (
            <span className="block text-[var(--warning)]">
              ≈{paceKnocks.toLocaleString()} knocks to week goal
            </span>
          )}
          {paceKnocks === 0 && (
            <span className="block text-victory">Week goal covered 🏆</span>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {liveText}
      </span>
    </div>
  );
});
