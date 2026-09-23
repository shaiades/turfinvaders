import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDaysISO, laMonthStartISO, nextMonthStartISO } from "@/lib/dates";
import { aggregateCloseKombat, type BlockCard } from "@/lib/close-kombat";
import type { RepMatcher } from "@/lib/rep-identity";
import type { OfficeFilter } from "@/lib/offices";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { rewardToast } from "@/lib/reward-toast";
import { clamp01, drawCoin, easeInOut, easeOutBack, makeBeeper, rr } from "./intro-fx";

/**
 * THE BELT DROP — "a sale landed while you were away" (owner ask
 * 2026-09-14). When a sales rep opens Close Kombat and the settled board
 * shows MORE month-to-date kept sales than the baseline persisted on their
 * last visit, a ~2.8s championship-belt ceremony plays: gold god-rays split
 * the dark, the title belt drops and SLAMS with the door-kick's own shock
 * ring + starburst, a blood-red case-file stamp THUDS "SALE CONFIRMED", and
 * the REAL dollar delta rolls up on a slot-machine odometer under a noir
 * spotlight. The gold toast fires as the receipt on every exit path.
 *
 * DETECTION (useSaleVictory) — the inverse of the live KA-CHING effect and
 * deliberately separate from it: KA-CHING is per-settle in-memory keyed to
 * the VISIBLE range; this is per-app-open persisted and keyed to the LA
 * month. They are mutually exclusive per settle — on the first settled
 * render kaChingRef.current is still null (it seeds before comparing), which
 * is precisely the only render the victory check can fire on. Rules:
 *  - Baseline `ti_ck_victory_base:v1:<uid>` stores {m, office, sales,
 *    revenue, at}. EVERY settle rewrites it — that one rule seeds first
 *    visits silently, ratchets DOWN on cancellations, and absorbs sales that
 *    already KA-CHING'd live so the next open stays quiet.
 *  - Month-to-date window (laMonthStartISO): a Today baseline would die at
 *    every midnight and a Mon-Sun one every Monday morning; the Day fetch's
 *    ±42d pad always covers the current month, so no extra query. Accepted
 *    blind spot: a sale first seen on the 1st reseeds silently.
 *  - NEVER-INVENT-NUMBERS: the dollar figure is the MTD revenue delta from
 *    aggregateCloseKombat's split volume (sale_price / report_reps chain),
 *    shown ONLY when positive — a new sale plus a bigger cancelled one shows
 *    the count with no figure. Trigger is COUNT increase only.
 *  - View-As can NEVER celebrate (or write a baseline for) a previewed
 *    rep's numbers — callers gate on privilegeRole(realRole).
 *  - Identity miss (matcher.matched === null) skips read AND write: a zero
 *    baseline written before the office fixes a board name would
 *    mass-celebrate the whole month once matching starts working.
 * Preview: `?sale_victory_demo=1` fires the visual with canned numbers and
 * ZERO baseline reads/writes (ck_anim / piggy_demo precedent).
 */

const VW = 640;
const VH = 360;
const GROUND = 300;
const DURATION = 2800;

const GOLD = "#ffd24a";
const GOLD_DEEP = "#a8770a";
const RED = "#f4543c";
const RED_DEEP = "#b32014";

type VictoryBase = { m: string; office: string; sales: number; revenue: number; at: string };
const baseKey = (uid: string) => `ti_ck_victory_base:v1:${uid}`;
const readBase = (uid: string): VictoryBase | null => {
  try {
    const raw = window.localStorage.getItem(baseKey(uid));
    if (!raw) return null;
    const v = JSON.parse(raw) as VictoryBase;
    return typeof v?.sales === "number" && typeof v?.m === "string" ? v : null;
  } catch {
    return null;
  }
};
const writeBase = (uid: string, b: VictoryBase) => {
  try {
    window.localStorage.setItem(baseKey(uid), JSON.stringify(b));
  } catch {
    /* private mode — silent, next open just reseeds */
  }
};

/** Once per APP OPEN (page load) per signed-in user. Module scope on
 *  purpose: survives route remounts, resets on reload — the "app open"
 *  unit, matching the SPA semantics of ?ck_anim / ?piggy_demo. */
const checkedThisLoad = new Set<string>();

export type VictoryFx = { salesDelta: number; dollarDelta: number | null };

export function useSaleVictory(opts: {
  userId: string | null;
  /** privilegeRole(realRole) === "sales_rep" && displayName === realDisplayName */
  eligible: boolean;
  /** cardsQuery.isSuccess && !cardsQuery.isPlaceholderData — the exact KA-CHING settle flags */
  settled: boolean;
  officeCards: BlockCard[];
  matcher: RepMatcher;
  office: OfficeFilter;
  fetchStart: string;
  fetchEnd: string;
}): { fx: VictoryFx | null; dismiss: () => void } {
  const [fx, setFx] = useState<VictoryFx | null>(null);
  const monthStart = laMonthStartISO();
  const monthEnd = addDaysISO(nextMonthStartISO(monthStart), -1);
  const monthKey = monthStart.slice(0, 7);
  const { settled, officeCards, matcher } = opts;
  // MTD row over the SAME padded fetch — NOT the visible range's myRow
  // (Today's row can't see last night).
  // Deliberately CARD-based money, diverging from the Month tab's report-book
  // volume (owner, 2026-09-23): the ceremony fires live on card sales whose
  // Sales-Report rows don't exist yet — the book lags by a sync, and a
  // celebration that waits for the office isn't one.
  const mtd = useMemo(() => {
    if (!settled) return null;
    const { reps } = aggregateCloseKombat(officeCards, { start: monthStart, end: monthEnd });
    return reps.find((r) => matcher.isMe(r.rep)) ?? null; // null = valid zero row
  }, [settled, officeCards, matcher, monthStart, monthEnd]);

  useEffect(() => {
    const { userId, eligible, office, fetchStart, fetchEnd } = opts;
    if (!userId || !eligible || !settled || !matcher.matched) return;
    // Past-range paging before first settle: the fetch may not cover MTD —
    // skip WITHOUT marking checked, so the first covering settle runs it.
    if (fetchStart > monthStart || fetchEnd < monthEnd) return;
    const sales = mtd ? mtd.sold + mtd.reloads : 0; // kept only; saves are volume-only and never tick these
    const revenue = mtd ? mtd.revenue : 0;
    if (!checkedThisLoad.has(userId)) {
      checkedThisLoad.add(userId); // one-shot per open, celebrate or not
      const base = readBase(userId);
      const comparable = base !== null && base.m === monthKey && base.office === office;
      if (comparable && sales > base.sales) {
        const dDollar = typeof base.revenue === "number" ? revenue - base.revenue : null;
        setFx({
          salesDelta: sales - base.sales,
          dollarDelta: dDollar !== null && dDollar > 0 ? Math.round(dDollar) : null,
        });
      }
    }
    writeBase(userId, { m: monthKey, office, sales, revenue, at: new Date().toISOString() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, officeCards, mtd]);

  return { fx, dismiss: useCallback(() => setFx(null), []) };
}

const fmtGold = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);

/** SFX beats (lazy-fired; a skip silences everything unplayed). */
type Beat = { ms: number; f: number; d: number; t: OscillatorType };
function buildSfx(hasDollars: boolean): Beat[] {
  const beats: Beat[] = [
    // descent pings tracking the belt through the rays
    { ms: 200, f: 196, d: 110, t: "sine" },
    { ms: 330, f: 262, d: 110, t: "sine" },
    { ms: 460 - 60, f: 330, d: 140, t: "sine" },
    // THE SLAM — the door-kick impact pair + sub bloom
    { ms: 460, f: 65, d: 150, t: "square" },
    { ms: 510, f: 48, d: 190, t: "square" },
    { ms: 460, f: 98, d: 320, t: "sine" },
    // stamp thud + ink settle
    { ms: 620, f: 110, d: 90, t: "square" },
    { ms: 680, f: 82, d: 120, t: "square" },
    { ms: 840, f: 587, d: 70, t: "sine" },
  ];
  const lockAt = hasDollars ? 1840 : 1500;
  if (hasDollars) {
    for (let i = 0; i < 8; i++) {
      // reel decelerates: skip every other tick past 1500
      const ms = 1100 + i * 90;
      if (ms > 1500 && i % 2 === 1) continue;
      beats.push({ ms, f: i % 2 ? 1174 : 1046, d: 28, t: "sine" });
    }
  }
  // the house ka-ching, verbatim
  beats.push({ ms: lockAt, f: 1318, d: 70, t: "sine" });
  beats.push({ ms: lockAt + 80, f: 1760, d: 260, t: "sine" });
  // gold shimmer glissando riding the gleam
  for (let i = 0; i < 5; i++)
    beats.push({ ms: lockAt + 90 + i * 55, f: 2093 * Math.pow(2, i / 8), d: 60, t: "sine" });
  // ceremony tag — the CLOSED! fanfare
  beats.push({ ms: 2100, f: 523, d: 90, t: "square" });
  beats.push({ ms: 2190, f: 659, d: 90, t: "square" });
  beats.push({ ms: 2280, f: 784, d: 110, t: "square" });
  beats.push({ ms: 2370, f: 1046, d: 170, t: "square" });
  return beats;
}

function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type P = { x: number; y: number; vx: number; vy: number; born: number; kind: "coin" | "ink" | "ember"; r: number; spin: number };

export function SaleVictoryOverlay({ fx, onDone }: { fx: VictoryFx; onDone: () => void }) {
  const reduced = usePrefersReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const [visible, setVisible] = useState(false);

  // onDone AND fx ride refs so `finish` (and the ceremony effect keyed on
  // it) is stable for the life of the mount — CloseKombat re-renders on
  // realtime refetches and state flips, and unstable props in the effect
  // deps would restart the belt drop from t=0 on each one (review catch
  // 2026-09-14; fx values never meaningfully change mid-ceremony).
  const onDoneRef = useRef(onDone);
  const fxRef = useRef(fx);
  useEffect(() => {
    onDoneRef.current = onDone;
    fxRef.current = fx;
  });
  const finish = useCallback(() => {
    if (doneRef.current) return; // skip, auto-end, failsafe all funnel here
    doneRef.current = true;
    // The receipt lands on every path — skipped, reduced-motion, or played out.
    const { salesDelta: n, dollarDelta } = fxRef.current;
    rewardToast(
      n === 1
        ? "🏆 VICTORY — a sale landed while you were out!"
        : `🏆 VICTORY — ${n} sales landed while you were out!`,
      dollarDelta ? { description: `${fmtGold(dollarDelta)} onto your month.` } : undefined,
    );
    onDoneRef.current();
  }, []);

  useEffect(() => {
    if (reduced) {
      finish(); // toast only — no art under prefers-reduced-motion
      return;
    }
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      finish();
      return;
    }
    const cssW = canvas.clientWidth || VW;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssW * (VH / VW) * dpr);
    const scale = canvas.width / VW;

    const fx0 = fxRef.current; // mount-time snapshot; the ceremony never re-reads
    const hasDollars = fx0.dollarDelta !== null && fx0.dollarDelta > 0;
    const lockAt = hasDollars ? 1840 : 1500;
    const figure = hasDollars ? `+${fmtGold(fx0.dollarDelta!)}` : "";
    const stampText =
      fx0.salesDelta === 1 ? "SALE CONFIRMED" : `${fx0.salesDelta} SALES CONFIRMED`;
    const sfx = buildSfx(hasDollars);
    const fired = new Set<number>();
    const beep = makeBeeper();
    const rng = makeRng(0xbe17);
    const particles: P[] = [];
    const sparkles = Array.from({ length: 5 }, () => ({
      x: VW * 0.2 + rng() * VW * 0.6,
      y: 120 + rng() * 140,
      ph: rng() * Math.PI * 2,
    }));
    const spawn = (kind: P["kind"], n: number, at: number, x = VW / 2, y = 190) => {
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (rng() - 0.5) * 1.8;
        const sp = kind === "ink" ? 1.5 + rng() * 2 : 3 + rng() * 4.5;
        particles.push({
          x: x + (rng() - 0.5) * 60,
          y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          born: at,
          kind,
          r: kind === "coin" ? 6 + rng() * 3 : 2 + rng() * 2,
          spin: rng() * Math.PI,
        });
      }
    };
    const spawned = new Set<number>();
    const BELT_Y = 190;
    setVisible(true);
    let lastNow = performance.now();
    const start = lastNow;

    const drawBelt = (silhouette: number, y: number) => {
      // straps: red rr capsules arcing off the plate, gold rivets
      ctx.save();
      ctx.translate(VW / 2, y);
      for (const dir of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const x0 = dir * (78 + i * 52);
          const yy = -6 + i * 9;
          const g = ctx.createLinearGradient(0, yy - 14, 0, yy + 14);
          g.addColorStop(0, silhouette ? "#2a1a12" : RED);
          g.addColorStop(1, silhouette ? "#1a0e08" : RED_DEEP);
          ctx.fillStyle = g;
          rr(ctx, x0 - 28, yy - 13, 56, 26, 12);
          ctx.fill();
          if (!silhouette) {
            ctx.fillStyle = GOLD;
            ctx.beginPath();
            ctx.arc(x0, yy, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      // plate
      const pg = ctx.createRadialGradient(0, -14, 6, 0, 0, 92);
      if (silhouette) {
        pg.addColorStop(0, "#31200f");
        pg.addColorStop(1, "#180e05");
      } else {
        pg.addColorStop(0, "#fffbe8");
        pg.addColorStop(0.55, GOLD);
        pg.addColorStop(1, GOLD_DEEP);
      }
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.ellipse(0, 0, 88, 58, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = silhouette ? "#0d0703" : "#7a5606";
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(0, 0, 70, 44, 0, 0, Math.PI * 2);
      ctx.stroke();
      if (!silhouette) drawCoin(ctx, 26); // house coin = belt jewel
      ctx.restore();
    };

    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(50, now - lastNow);
      lastNow = now;
      const t = now - start;
      if (t >= DURATION) {
        finish();
        return; // battery rule — the chain ends here
      }
      if (t >= DURATION - 300) setVisible(false);
      for (const b of sfx) {
        const key = b.ms * 100000 + b.f;
        if (t >= b.ms && !fired.has(key)) {
          fired.add(key);
          try {
            beep(b.f, b.d, 0, b.t);
          } catch {
            /* garnish */
          }
        }
      }
      // particle spawns
      const spawnOnce = (at: number, fn: () => void) => {
        if (t >= at && !spawned.has(at)) {
          spawned.add(at);
          fn();
        }
      };
      spawnOnce(0, () => spawn("ember", 10, t, VW / 2, VH));
      spawnOnce(460, () => spawn("ember", 14, t));
      spawnOnce(620, () => spawn("ink", 8, t, VW / 2, 150));
      spawnOnce(1060, () => spawn("coin", hasDollars ? 10 : 20, t));
      spawnOnce(1300, () => spawn("coin", hasDollars ? 10 : 20, t));
      const k = dt / 16.7;
      for (const p of particles) {
        p.x += p.vx * k;
        p.y += p.vy * k;
        p.vy += (p.kind === "ember" ? -0.02 : 0.3) * k; // embers rise
        p.spin += 0.2 * k;
        if (p.kind === "coin" && p.y > GROUND && p.vy > 0) p.vy = -p.vy * 0.45;
      }

      // ── camera: base push + slam punches + shakes ──────────────────────
      let zoom = 1 + 0.06 * easeInOut(clamp01(t / 2600));
      const punch = (at: number, amt: number, len: number) => {
        const d = t - at;
        if (d > 0 && d < len) zoom += amt * (1 - easeOutBack(clamp01(d / len)) * 0.999);
      };
      punch(460, 0.08, 600);
      punch(620, 0.03, 300);
      let sx = 0;
      let sy = 0;
      for (const [at, amp, len] of [
        [460, 4.5, 260],
        [620, 6, 200],
        [lockAt, 1.6, 180],
      ] as const) {
        const d = t - at;
        if (d > 0 && d < len) {
          const dec = 1 - d / len;
          sx += Math.sin(d * 0.9) * amp * dec;
          sy += Math.cos(d * 1.3) * amp * dec * 0.6;
        }
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      // warm-black void (matches the overlay div so canvas edges vanish)
      const bg = ctx.createRadialGradient(VW / 2, VH * 0.4, 0, VW / 2, VH * 0.4, VH * 0.9);
      bg.addColorStop(0, "#1c0b10");
      bg.addColorStop(1, "#070408");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, VW, VH);
      ctx.translate(VW / 2 + sx, VH / 2 + sy);
      ctx.scale(zoom, zoom);
      ctx.translate(-VW / 2, -VH / 2);

      // ── god-rays fanning down, rotating slowly ─────────────────────────
      const rayA = clamp01((t - 140) / 200) * (t > 2380 ? 1 - clamp01((t - 2380) / 400) * 0.5 : 1);
      if (rayA > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const rg = ctx.createLinearGradient(0, -80, 0, VH * 0.75);
        rg.addColorStop(0, `rgba(255,214,110,${0.16 * rayA})`);
        rg.addColorStop(1, "rgba(255,214,110,0)");
        ctx.fillStyle = rg;
        for (let i = 0; i < 5; i++) {
          const ang = Math.PI / 2 + (i - 2) * 0.28 + Math.sin(t * 0.00012 + i) * 0.06;
          const w = 0.11;
          ctx.beginPath();
          ctx.moveTo(320, -80);
          ctx.lineTo(320 + Math.cos(ang - w) * 700, -80 + Math.sin(ang - w) * 700);
          ctx.lineTo(320 + Math.cos(ang + w) * 700, -80 + Math.sin(ang + w) * 700);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      // floor glow pool under the belt rest point
      const slamP = clamp01((t - 380) / 80);
      if (slamP > 0) {
        ctx.globalAlpha = 0.35 * slamP;
        const fg = ctx.createRadialGradient(VW / 2, BELT_Y + 60, 0, VW / 2, BELT_Y + 60, 150);
        fg.addColorStop(0, GOLD);
        fg.addColorStop(1, "rgba(255,210,74,0)");
        ctx.fillStyle = fg;
        ctx.beginPath();
        ctx.ellipse(VW / 2, BELT_Y + 60, 150, 40, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ── the belt: fall → slam → rest ───────────────────────────────────
      if (t >= 140) {
        const fallP = clamp01((t - 140) / 320);
        const y = t < 460 ? -80 + (BELT_Y + 80) * fallP * fallP : BELT_Y;
        if (t < 460) {
          // motion streaks above the falling silhouette
          ctx.globalAlpha = 0.25;
          ctx.strokeStyle = GOLD;
          ctx.lineWidth = 2;
          for (let i = 0; i < 4; i++) {
            ctx.beginPath();
            ctx.moveTo(VW / 2 - 45 + i * 30, y - 90 - i * 12);
            ctx.lineTo(VW / 2 - 45 + i * 30, y - 40);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          drawBelt(1, y);
        } else {
          drawBelt(0, BELT_Y);
        }
      }
      // slam fx: shock ring + 3-layer starburst
      const slamAge = t - 460;
      if (slamAge > 0 && slamAge < 420) {
        const p = easeInOut(clamp01(slamAge / 420));
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 1 - p;
        ctx.lineWidth = 8 * (1 - p) + 1;
        ctx.strokeStyle = "#fff6d8";
        ctx.beginPath();
        ctx.arc(VW / 2, BELT_Y, 6 + p * 120, 0, Math.PI * 2);
        ctx.stroke();
        for (let layer = 0; layer < 3; layer++) {
          const ls = [1, 0.7, 0.45][layer];
          ctx.globalAlpha = (1 - p) * [0.8, 0.5, 0.3][layer];
          ctx.fillStyle = layer === 0 ? "#ffffff" : GOLD;
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + layer * 0.26;
            const L = (36 + p * 120) * ls;
            ctx.save();
            ctx.translate(VW / 2, BELT_Y);
            ctx.rotate(a);
            ctx.beginPath();
            ctx.moveTo(10, 0);
            ctx.lineTo(L, -3 * ls);
            ctx.lineTo(L, 3 * ls);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
          }
        }
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
      }

      // ── particles ──────────────────────────────────────────────────────
      for (const p of particles) {
        const age = t - p.born;
        const life = p.kind === "coin" ? 1700 : p.kind === "ink" ? 800 : 2400;
        if (age > life) continue;
        ctx.globalAlpha = 1 - age / life;
        if (p.kind === "coin") {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(Math.max(0.15, Math.abs(Math.cos(p.spin))), 1);
          drawCoin(ctx, p.r);
          ctx.restore();
        } else {
          ctx.fillStyle = p.kind === "ink" ? RED_DEEP : "#ffca7a";
          ctx.fillRect(p.x, p.y, p.r, p.r * 1.6);
        }
      }
      ctx.globalAlpha = 1;

      // ── case-file stamp: accelerating drop, no bounce ──────────────────
      if (t >= 620) {
        const dropP = clamp01((t - 620) / 120);
        const sc = 2.6 - 1.6 * dropP * dropP; // easeInQuad — stamps HIT
        ctx.save();
        ctx.translate(VW / 2, 108);
        ctx.rotate(-0.14);
        ctx.scale(sc, sc);
        ctx.globalAlpha = 0.35 + 0.65 * dropP;
        ctx.font = "900 30px 'Arial Black', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const w = ctx.measureText(stampText).width + 44;
        ctx.lineWidth = 5;
        ctx.strokeStyle = RED;
        rr(ctx, -w / 2, -26, w, 52, 8);
        ctx.stroke();
        const tg = ctx.createLinearGradient(0, -15, 0, 15);
        tg.addColorStop(0, "#ff5a3c");
        tg.addColorStop(1, RED_DEEP);
        ctx.fillStyle = tg;
        ctx.shadowColor = "#ff3b1f";
        ctx.shadowBlur = 14;
        ctx.fillText(stampText, 0, 1);
        ctx.shadowBlur = 0;
        // uneven-ink ghost strokes
        ctx.globalAlpha *= 0.25;
        ctx.strokeStyle = RED_DEEP;
        ctx.lineWidth = 1;
        ctx.strokeText(stampText, 1, 2);
        ctx.strokeText(stampText, -1, 0);
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // ── odometer under the noir spotlight ──────────────────────────────
      const digitsY = 262;
      if (hasDollars && t >= 1060) {
        // darkness pass: dim the ceremony, punch a light hole on plate+digits
        const darkIn = clamp01((t - 1060) / 180);
        const darkOut = 1 - clamp01((t - lockAt - 140) / 200);
        const dark = 0.55 * Math.min(darkIn, darkOut);
        if (dark > 0.01) {
          ctx.save();
          ctx.fillStyle = `rgba(0,0,0,${dark})`;
          ctx.fillRect(-40, -40, VW + 80, VH + 80);
          ctx.globalCompositeOperation = "destination-out";
          const hole = ctx.createRadialGradient(VW / 2, 215, 20, VW / 2, 215, 190);
          hole.addColorStop(0, `rgba(0,0,0,${dark + 0.2})`);
          hole.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = hole;
          ctx.fillRect(-40, -40, VW + 80, VH + 80);
          ctx.globalCompositeOperation = "source-over";
          ctx.restore();
        }
        // per-column digit strips, staggered right-slowest like a real reel
        const chars = figure.split("");
        const dh = 44;
        ctx.font = "900 40px 'Arial Black', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const widths = chars.map((c) => (/\d/.test(c) ? 30 : ctx.measureText(c).width + 2));
        const total = widths.reduce((a, b) => a + b, 0);
        let x = VW / 2 - total / 2;
        const lockPulse = t > lockAt && t < lockAt + 140 ? 1 + 0.08 * Math.sin(((t - lockAt) / 140) * Math.PI) : 1;
        ctx.save();
        ctx.translate(VW / 2, digitsY);
        ctx.scale(lockPulse, lockPulse);
        ctx.translate(-VW / 2, -digitsY);
        chars.forEach((c, i) => {
          const cx = x + widths[i] / 2;
          x += widths[i];
          const gg = ctx.createLinearGradient(0, digitsY - 20, 0, digitsY + 20);
          gg.addColorStop(0, "#fff3c4");
          gg.addColorStop(0.6, GOLD);
          gg.addColorStop(1, GOLD_DEEP);
          ctx.fillStyle = gg;
          ctx.strokeStyle = "#241503";
          ctx.lineWidth = 5;
          if (!/\d/.test(c)) {
            const ap = clamp01((t - 1060) / 300);
            ctx.globalAlpha = ap;
            ctx.strokeText(c, cx, digitsY);
            ctx.fillText(c, cx, digitsY);
            ctx.globalAlpha = 1;
            return;
          }
          const target = Number(c);
          const digitIdx = chars.slice(0, i).filter((q) => /\d/.test(q)).length;
          const p = easeInOut(clamp01((t - 1060 - digitIdx * 55) / 780));
          const spins = 14 + digitIdx * 5;
          const off = (spins + target) * (1 - p) + target;
          const lo = Math.floor(off);
          const frac = off - lo;
          ctx.save();
          ctx.beginPath();
          ctx.rect(cx - 17, digitsY - dh / 2, 34, dh);
          ctx.clip();
          for (const [d0, dy] of [
            [lo % 10, frac * dh],
            [(lo + 1) % 10, (frac - 1) * dh],
          ] as const) {
            ctx.strokeText(String(d0), cx, digitsY + dy);
            ctx.fillText(String(d0), cx, digitsY + dy);
          }
          ctx.restore();
        });
        ctx.restore();
        // gleam sweeps: digits at lock, plate 80ms later
        for (const [at, gy, gw, gh] of [
          [lockAt, digitsY, total + 30, 52],
          [lockAt + 80, BELT_Y, 200, 120],
        ] as const) {
          const gp = t - at;
          if (gp > 0 && gp < 260) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(VW / 2 - gw / 2, gy - gh / 2, gw, gh);
            ctx.clip();
            ctx.globalCompositeOperation = "lighter";
            const gx = VW / 2 - gw / 2 + (gw + 60) * (gp / 260) - 30;
            const gl = ctx.createLinearGradient(gx - 18, 0, gx + 18, 0);
            gl.addColorStop(0, "rgba(255,255,255,0)");
            gl.addColorStop(0.5, "rgba(255,255,255,0.55)");
            gl.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = gl;
            ctx.save();
            ctx.translate(gx, gy);
            ctx.rotate(-0.35);
            ctx.fillRect(-22, -gh, 44, gh * 2);
            ctx.restore();
            ctx.restore();
          }
        }
      }

      // ── ceremony hold: engraving + sparkles ────────────────────────────
      if (t >= 1980) {
        const ep = clamp01((t - 1980) / 300);
        ctx.globalAlpha = ep * 0.9;
        ctx.font = "700 13px 'Arial Black', Arial, sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = GOLD;
        ctx.fillText("W H I L E   Y O U   W E R E   O U T", VW / 2, hasDollars ? 302 : 268);
        ctx.globalAlpha = 1;
        for (const sp2 of sparkles) {
          const a = 0.4 + 0.6 * Math.abs(Math.sin(t * 0.004 + sp2.ph));
          const r2 = 3 + 2 * Math.abs(Math.sin(t * 0.003 + sp2.ph));
          ctx.globalAlpha = a * ep;
          ctx.fillStyle = "#fff6d8";
          ctx.beginPath();
          ctx.moveTo(sp2.x, sp2.y - r2);
          ctx.lineTo(sp2.x + r2 * 0.35, sp2.y);
          ctx.lineTo(sp2.x, sp2.y + r2);
          ctx.lineTo(sp2.x - r2 * 0.35, sp2.y);
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      // white flashes (screen-space feel, drawn last in virtual space)
      for (const [at, a0] of [
        [460, 0.3],
        [620, 0.18],
      ] as const) {
        const d = t - at;
        if (d > 0 && d < 70) {
          ctx.globalAlpha = a0 * (1 - d / 70);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(-40, -40, VW + 80, VH + 80);
          ctx.globalAlpha = 1;
        }
      }
      // settle vignette
      if (t > 2380) {
        const vp = clamp01((t - 2380) / 220) * 0.5;
        const vg = ctx.createRadialGradient(VW / 2, VH / 2, VH * 0.35, VW / 2, VH / 2, VH * 0.85);
        vg.addColorStop(0, "rgba(0,0,0,0)");
        vg.addColorStop(1, `rgba(0,0,0,${vp})`);
        ctx.fillStyle = vg;
        ctx.fillRect(-40, -40, VW + 80, VH + 80);
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const failsafe = window.setTimeout(finish, DURATION + 600);
    const skip = () => finish();
    window.addEventListener("keydown", skip);
    return () => {
      cancelAnimationFrame(raf); // battery rule: unmount kills the loop
      window.clearTimeout(failsafe);
      window.removeEventListener("keydown", skip);
    };
  }, [reduced, finish]);

  if (reduced || typeof document === "undefined") return null;
  return createPortal(
    <div
      role="presentation"
      onPointerDown={finish}
      className="fixed inset-0 z-[10030] flex flex-col items-center justify-center select-none"
      style={{
        background: "radial-gradient(ellipse at 50% 40%, #1c0b10 0%, #070408 70%)",
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease",
        cursor: "pointer",
      }}
    >
      <div
        className="relative w-[min(92vw,720px)] overflow-hidden rounded-xl"
        style={{
          aspectRatio: "640 / 360",
          boxShadow:
            "0 0 40px -10px color-mix(in oklab, var(--kombat-gold) 45%, transparent), 0 24px 60px -20px rgba(0,0,0,0.9)",
        }}
      >
        <canvas ref={canvasRef} width={VW} height={VH} className="w-full h-full" />
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.45) 100%)",
          }}
        />
      </div>
      <div className="mt-4 text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
        Kept on your board
      </div>
      <div className="absolute bottom-[max(1rem,env(safe-area-inset-bottom))] text-[9px] font-display uppercase tracking-widest text-white/40">
        Tap to skip ▸
      </div>
    </div>,
    document.body,
  );
}
