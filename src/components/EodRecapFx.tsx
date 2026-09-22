import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { addDaysISO, completedReportDay, fmtWorkedDay, lastWorkedDaysBefore } from "@/lib/dates";
import { useClockPresence, useDailyWrapRows, type WrapRow } from "@/hooks/useDailyWrapRows";
import { clamp01, easeInOut, easeOutBack, makeBeeper, popText, rr } from "./intro-fx";

/**
 * END-OF-DAY RECAP (owner ask 2026-09-22): a two-act cutscene that auto-plays
 * once per COMPLETED report day, on the next app open after the 6 PM PT lock
 * — the guaranteed delivery channel (push only reaches subscribed devices).
 * Act 1 (~4s): "TOP CANVASSERS" — the day's top 3 by leads on a podium of
 * gold/silver/bronze cards, counts ticking up, confetti on #1. Act 2 (~3.5s,
 * immediately after): "THE DOUGHNUT ZONE" — a 🍩 rain and name chips for
 * everyone who clocked in and put up a zero, in the app's donut-club dialect
 * (frozen ❄ = second straight zero, matching the Wrap's freezer).
 *
 * Data = the Daily Wrap's own rules via useDailyWrapRows, anchored at the
 * completed day D (so this component's `todayLeads` IS the judged day):
 *  - winners: todayLeads >= 1, sorted desc, top 3 — the Wrap's winner rule.
 *  - donuts:  todayLeads === 0 && active && !graced && clocked on D. Keep in
 *    LOCKSTEP with daily-wrap.tsx's zero-list selectors. One deliberate
 *    divergence: "frozen" pairs D with the previous WORKED day
 *    (lastWorkedDaysBefore), not calendar D-1, dodging the Sunday hole where
 *    a Monday zero could never freeze. Missing clock presence ⇒ donut list
 *    EMPTY (missing data never flags a person); winners still play.
 *
 * Gate protocol (WelcomeAnimation's, plus a data stage): stamps store the
 * report-day ISO played — localStorage `ti_eod_recap_v1:<uid>` first, auth
 * user_metadata `ti_eod_recap` as the cross-device backstop — and "seen" is
 * EXACT string equality with completedReportDay() (never isLaToday: the
 * judged day is yesterday's date most of the time). The stamp is written when
 * playback STARTS so an interrupted run can't loop. A genuinely empty day
 * (nobody clocked in, nobody scored) stamps and skips; a fetch ERROR skips
 * WITHOUT stamping so the next open retries; reduced motion skips without
 * stamping (the Daily Wrap page is the accessible record). A visibilitychange
 * re-arm covers the installed-PWA case where "opening the app" resumes the
 * same SPA session instead of reloading it — the 6 PM push lands, the rep
 * foregrounds the app, and the recap must still fire.
 *
 * Sequencing: AppShell mounts this AFTER the morning intro with
 * `heldBack={introActive}` — data warms while the van scene plays, the
 * ready→playing hop waits for the intro, and the page tour waits for both.
 * Role gate lives in AppShell on privilegeRole(realRole) (never View-As).
 *
 * Preview: `?eod_demo=1` force-plays with canned names (3 winners, 11 donuts
 * to exercise the "+N MORE" overflow) and never stamps; `&eod_hold=<ms>`
 * freezes the scene at that timestamp. Deliberate non-goal: no navigation on
 * finish — the recap is a ritual, not a redirect; the Wrap nav item is the
 * full record.
 */

const VW = 640;
const VH = 360;
const GROUND = 300;

const GOLD = "#ffd24a";
const GOLD_DEEP = "#a8770a";
const ICE = "#bfe3ff";
const ICE_GLOW = "rgba(74,168,255,0.8)";

const seenKey = (uid: string) => `ti_eod_recap_v1:${uid}`;

type RecapMeta = { ti_eod_recap?: string };

/** `?eod_demo=1` forces a preview for any signed-in account (flags are never
 *  written). AppShell also uses this so leadership can preview from any role. */
export function isEodRecapForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("eod_demo") === "1";
}

/** "Seen" = the stored stamp IS the given report day. */
function readLocalSeen(key: string, day: string): boolean {
  try {
    return window.localStorage.getItem(key) === day;
  } catch {
    return true; // can't persist "seen" → never loop the recap
  }
}

function writeLocal(key: string, day: string) {
  try {
    window.localStorage.setItem(key, day);
  } catch {
    /* private mode — the metadata write still covers us */
  }
}

type Winner = { name: string; leads: number };
type Donut = { name: string; frozen: boolean };
type RecapData = { day: string; winners: Winner[]; donuts: Donut[] };

const DEMO_WINNERS: Winner[] = [
  { name: "Ace Demo", leads: 4 },
  { name: "Blaze Preview", leads: 3 },
  { name: "Cruz Sample", leads: 2 },
];
const DEMO_DONUTS: Donut[] = [
  { name: "Frost Example", frozen: true },
  { name: "Drift Example", frozen: true },
  ...["Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima", "Mike"].map(
    (n) => ({ name: `${n} Example`, frozen: false }),
  ),
];

/* ── Timeline (computed per playback from the data snapshot — degenerate
 *    days compress instead of holding dead air) ─────────────────────────── */

const CHIP_STEP = 260;
const MAX_CHIP_NAMES = 8;

function buildTimeline(winnerCount: number, donutCount: number) {
  const T_TITLE = 250;
  // Podium pops lowest rank first; #1 always lands last.
  const popAt = (rankIdx: number) => 950 + (winnerCount - 1 - rankIdx) * 600;
  const T_TOP = winnerCount > 0 ? popAt(0) : 0; // #1 lands, confetti + fanfare
  const T_SHINE = T_TOP + 750; // counts finish ticking, gleam sweeps
  const T_ACT1_OUT = winnerCount > 0 ? T_SHINE + 700 : 1600;
  const T_ACT2 = T_ACT1_OUT + 400;
  const T_RAIN = T_ACT2 + 300;
  const T_NAMES = T_ACT2 + 800;
  const chipCount = Math.min(donutCount, MAX_CHIP_NAMES) + (donutCount > MAX_CHIP_NAMES ? 1 : 0);
  const T_TAG = donutCount > 0 ? T_NAMES + chipCount * CHIP_STEP + 350 : T_ACT2 + 600;
  const T_FADE = T_TAG + (donutCount > 0 ? 900 : 1300);
  const DURATION = T_FADE + 450;
  return { T_TITLE, popAt, T_TOP, T_SHINE, T_ACT1_OUT, T_ACT2, T_RAIN, T_NAMES, chipCount, T_TAG, T_FADE, DURATION };
}
type Timeline = ReturnType<typeof buildTimeline>;

/** SFX beats, lazy-fired against a `fired` set — a skip silences the rest.
 *  Donut-bounce boings are physics-timed and fire from the sim instead. */
type Beat = { ms: number; f: number; d: number; t: OscillatorType };
function buildSfx(tl: Timeline, winnerCount: number, donutCount: number): Beat[] {
  const beats: Beat[] = [
    // title arp
    { ms: tl.T_TITLE, f: 523, d: 90, t: "sine" },
    { ms: tl.T_TITLE + 90, f: 659, d: 90, t: "sine" },
    { ms: tl.T_TITLE + 180, f: 784, d: 130, t: "sine" },
  ];
  for (let i = winnerCount - 1; i >= 1; i--)
    beats.push({ ms: tl.popAt(i), f: i === 2 ? 659 : 784, d: 80, t: "square" });
  if (winnerCount > 0) {
    // #1 fanfare + count ticks + shine gliss
    beats.push({ ms: tl.T_TOP, f: 1046, d: 90, t: "square" });
    beats.push({ ms: tl.T_TOP + 90, f: 1318, d: 90, t: "square" });
    beats.push({ ms: tl.T_TOP + 180, f: 1760, d: 200, t: "square" });
    for (let i = 0; i < 6; i++)
      beats.push({ ms: tl.T_TOP + 150 + i * 100, f: i % 2 ? 1174 : 1046, d: 26, t: "sine" });
    for (let i = 0; i < 4; i++)
      beats.push({ ms: tl.T_SHINE + i * 60, f: 2093 * Math.pow(2, i / 8), d: 55, t: "sine" });
  } else {
    beats.push({ ms: 800, f: 330, d: 180, t: "sine" });
  }
  // freezer womp descend into Act 2
  [392, 330, 262, 196].forEach((f, i) => beats.push({ ms: tl.T_ACT2 + i * 110, f, d: 130, t: "square" }));
  for (let i = 0; i < tl.chipCount; i++)
    beats.push({ ms: tl.T_NAMES + i * CHIP_STEP, f: 587, d: 40, t: "sine" });
  if (donutCount === 0) {
    // everyone scored — a little victory blip instead of the walk of shame
    beats.push({ ms: tl.T_TAG, f: 1046, d: 90, t: "square" });
    beats.push({ ms: tl.T_TAG + 100, f: 1568, d: 180, t: "square" });
  }
  return beats;
}

/* ── Particles (fixed-step sim so `eod_hold` can fast-forward to any t) ── */

function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const CONFETTI_COLORS = ["#ff2d92", "#00f0ff", "#39ff14", "#ffd93d", "#a855f7"];
type Confetto = { x: number; y: number; vx: number; vy: number; rot: number; vr: number; c: string; w: number; h: number };
type DonutDrop = { x: number; y: number; vy: number; size: number; spawned: boolean; bounces: number; squashAt: number };

const STARS = Array.from({ length: 24 }, (_, i) => ({
  x: (i * 61 + 17) % VW,
  y: ((i * 41 + 9) % 120) + 10,
  r: (i % 3) * 0.4 + 0.8,
}));

function fitFont(ctx: CanvasRenderingContext2D, text: string, maxW: number, base: number): number {
  let size = base;
  for (;;) {
    ctx.font = `900 ${size}px "Arial Black", "Helvetica Neue", sans-serif`;
    if (size <= 9 || ctx.measureText(text).width <= maxW) return size;
    size -= 1;
  }
}

// Podium slots by rank (0 = #1, center + tallest).
const SLOTS = [
  { cx: 320, w: 200, h: 148, tone: ["#fffbe8", GOLD, GOLD_DEEP], ink: "#241503" },
  { cx: 138, w: 168, h: 112, tone: ["#f4f7ff", "#c0c8d8", "#67738c"], ink: "#141a26" },
  { cx: 502, w: 168, h: 100, tone: ["#ffe9d6", "#d98d4a", "#8a4f1d"], ink: "#241206" },
] as const;

// Donut chip grid: 3 × 3 in the 640-wide space (8 names + the overflow chip).
const CHIP_XS = [120, 320, 520];
const CHIP_YS = [140, 192, 244];
const CHIP_W = 186;
const CHIP_H = 40;

/* ── Component ─────────────────────────────────────────────────────────── */

export function EodRecapFx({
  userId,
  heldBack,
  onActiveChange,
}: {
  userId: string;
  /** True while the morning intro is checking/playing — the recap defers. */
  heldBack?: boolean;
  onActiveChange?: (active: boolean) => void;
}) {
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const forced = isEodRecapForced();
  const holdParam = forced ? params?.get("eod_hold") : null;
  const hold = holdParam ? Math.max(0, Number(holdParam) || 0) : null;

  // The judged day. State (not a mount-time constant) because the
  // visibilitychange re-arm below rolls it when the 6 PM lock passes while
  // the SPA stayed alive in the background.
  const [day, setDay] = useState(() => (typeof window === "undefined" ? "" : completedReportDay()));
  const [phase, setPhase] = useState<"checking" | "loading" | "playing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "playing";
    return readLocalSeen(seenKey(userId), completedReportDay()) ? "done" : "checking";
  });
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState(false); // drives the CSS fade
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const dataRef = useRef<RecapData | null>(
    forced ? { day: typeof window === "undefined" ? "" : completedReportDay(), winners: DEMO_WINNERS, donuts: DEMO_DONUTS } : null,
  );

  useEffect(() => {
    if (phase === "done") doneRef.current = true;
    onActiveChange?.(phase !== "done");
    // Unmount mid-play (sign-out, role swap) must release the tutorial hold.
    return () => onActiveChange?.(false);
  }, [phase, onActiveChange]);

  const markSeen = useCallback(
    (d: string) => {
      if (forced) return; // previews never stamp the real flag
      writeLocal(seenKey(userId), d);
      const patch: RecapMeta = { ti_eod_recap: d };
      supabase.auth.updateUser({ data: patch }).catch(() => {});
    },
    [forced, userId],
  );

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase("done");
  }, []);

  // Stage 1 — stamp checks (reduced motion, localStorage, cross-device
  // metadata). Passing them all moves to the data stage.
  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    (async () => {
      // Reduced motion skips playback WITHOUT stamping — the Wrap page is
      // the accessible record, and turning it off later still owes the day.
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        if (!cancelled) finish();
        return;
      }
      if (readLocalSeen(seenKey(userId), day)) {
        if (!cancelled) finish();
        return;
      }
      const meta = await Promise.race([
        supabase.auth
          .getSession()
          .then(({ data }) => (data.session?.user?.user_metadata ?? {}) as RecapMeta),
        new Promise<RecapMeta>((resolve) => window.setTimeout(() => resolve({}), 1200)),
      ]).catch(() => ({}) as RecapMeta);
      if (cancelled) return;
      if (meta.ti_eod_recap === day) {
        writeLocal(seenKey(userId), day);
        finish();
      } else {
        setPhase("loading");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, day, userId, finish]);

  // Stage 2 — fetch the judged day's rows + clock presence, then decide.
  const rowsQ = useDailyWrapRows(day, phase === "loading" && day !== "");
  const prevWorked = useMemo(() => (day ? lastWorkedDaysBefore(day, 1)[0] : ""), [day]);
  const clockDates = useMemo(() => (day ? [...new Set([day, prevWorked])] : []), [day, prevWorked]);
  const { clockReady, clockSettled, clockedOn } = useClockPresence(
    clockDates,
    phase === "loading" && day !== "",
  );

  useEffect(() => {
    if (phase !== "loading") return;
    if (!(rowsQ.isSuccess || rowsQ.isError) || !clockSettled) return;
    if (rowsQ.isError) {
      finish(); // no stamp — the next open retries
      return;
    }
    const rows = rowsQ.data ?? [];
    const winners: Winner[] = rows
      .filter((r) => r.todayLeads >= 1)
      .sort((a, b) => b.todayLeads - a.todayLeads)
      .slice(0, 3)
      .map((r) => ({ name: r.name, leads: r.todayLeads }));
    // The previous worked day's lead bucket: normally ydayLeads (D-1); when D
    // is a Monday the previous worked day is Saturday = D-2 = yday2Leads.
    const prevBucket = (r: WrapRow) =>
      prevWorked === addDaysISO(day, -1) ? r.ydayLeads : r.yday2Leads;
    const donuts: Donut[] = !clockReady
      ? [] // presence failed — never flag on missing data
      : rows
          .filter((r) => r.todayLeads === 0 && r.active && !r.graced && clockedOn(r.id, day))
          .map((r) => ({
            name: r.name,
            frozen:
              prevBucket(r) === 0 && clockedOn(r.id, prevWorked) && r.tracked && r.recent,
          }))
          .sort((a, b) => Number(b.frozen) - Number(a.frozen) || a.name.localeCompare(b.name));
    if (winners.length === 0 && donuts.length === 0) {
      // A genuinely empty day (day off, holiday) settles with a stamp so we
      // never re-fetch for it — but only when presence actually loaded:
      // an unverifiable day stays unstamped and retries next open.
      if (clockReady) markSeen(day);
      finish();
      return;
    }
    dataRef.current = { day, winners, donuts };
    setReady(true);
  }, [phase, rowsQ.isSuccess, rowsQ.isError, rowsQ.data, clockSettled, clockReady, clockedOn, day, prevWorked, markSeen, finish]);

  // Ready → playing, once the morning intro is out of the way. The fetch
  // warmed during the intro; this hop is the only thing that waits.
  useEffect(() => {
    if (phase !== "loading" || !ready || heldBack) return;
    setPhase("playing");
  }, [phase, ready, heldBack]);

  // Watchdog: a hung fetch (field networks) must not hold the page tour
  // hostage all session via onActiveChange. No stamp — next open retries.
  useEffect(() => {
    if (phase !== "loading") return;
    const wd = window.setTimeout(finish, 8000);
    return () => window.clearTimeout(wd);
  }, [phase, finish]);

  // Re-arm on foreground: installed-PWA opens resume the SPA instead of
  // reloading, so a settled "done" must re-check when the completed day has
  // rolled past the stamp (e.g. the 6 PM push brought them back).
  useEffect(() => {
    if (forced) return;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      if (!doneRef.current) return; // mid-cycle — leave the machine alone
      const d = completedReportDay();
      if (readLocalSeen(seenKey(userId), d)) return;
      doneRef.current = false;
      setReady(false);
      setDay(d);
      setPhase("checking");
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [forced, userId]);

  // Playback — one canvas, one rAF, both acts on a single beat table.
  useEffect(() => {
    if (phase !== "playing") return;
    const data = dataRef.current;
    if (!data) {
      finish();
      return;
    }
    markSeen(data.day); // written at START so an interrupted run can't loop
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

    const { winners, donuts } = data;
    const tl = buildTimeline(winners.length, donuts.length);
    const sfx = hold == null ? buildSfx(tl, winners.length, donuts.length) : [];
    const fired = new Set<number>();
    const beep = makeBeeper();
    const rng = makeRng(0xd0_9821);
    const dateLabel = data.day ? fmtWorkedDay(data.day).toUpperCase() : "";

    // Fixed-step particle sim: deterministic, so `eod_hold` just fast-forwards.
    const confetti: Confetto[] = [];
    let confettiDone = false;
    const DONUT_N = donuts.length > 0 ? 10 : 0;
    const drops: DonutDrop[] = Array.from({ length: DONUT_N }, () => ({
      x: 40 + rng() * 560,
      y: -26,
      vy: 0.5 + rng() * 1.4,
      size: 22 + rng() * 12,
      spawned: false,
      bounces: 0,
      squashAt: -1,
    }));
    let boings = 0;
    let simT = 0;
    const stepSim = (to: number) => {
      while (simT < to) {
        simT = Math.min(to, simT + 16.7);
        if (!confettiDone && winners.length > 0 && simT >= tl.T_TOP) {
          confettiDone = true;
          for (let i = 0; i < 70; i++) {
            confetti.push({
              x: 320 + (rng() - 0.5) * 120,
              y: 150 + (rng() - 0.5) * 30,
              vx: (rng() - 0.5) * 4.4,
              vy: -(2.4 + rng() * 4.4),
              rot: rng() * Math.PI,
              vr: (rng() - 0.5) * 0.35,
              c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              w: 3 + rng() * 3,
              h: 6 + rng() * 5,
            });
          }
        }
        for (const c of confetti) {
          c.x += c.vx;
          c.y += c.vy;
          c.vy += 0.13;
          c.rot += c.vr;
        }
        drops.forEach((p, i) => {
          if (!p.spawned) {
            if (simT >= tl.T_RAIN + i * 90) p.spawned = true;
            else return;
          }
          p.y += p.vy;
          p.vy += 0.34;
          const floor = GROUND - 8;
          if (p.y > floor && p.vy > 0) {
            if (Math.abs(p.vy) < 1) {
              p.y = floor;
              p.vy = 0; // settled
            } else {
              p.vy = -p.vy * 0.45;
              p.squashAt = simT;
              p.bounces++;
              if (p.bounces === 1 && boings < 4 && hold == null) {
                boings++;
                beep(170 + rng() * 90, 110, 0, "sine");
              }
            }
          }
        });
      }
    };

    setVisible(true);
    const start = performance.now();
    let raf = 0;

    const step = (now: number) => {
      const t = hold ?? now - start;
      stepSim(t);
      if (hold == null) {
        for (const b of sfx) {
          const key = b.ms * 100000 + b.f;
          if (t >= b.ms && !fired.has(key)) {
            fired.add(key);
            beep(b.f, b.d, 0, b.t);
          }
        }
        if (t >= tl.T_FADE) setVisible(false);
        if (t >= tl.DURATION) {
          finish();
          return;
        }
      }

      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      // ── background: navy night crossfading to freezer blue-grey ─────────
      const p2 = clamp01((t - tl.T_ACT1_OUT) / (tl.T_ACT2 - tl.T_ACT1_OUT));
      const bg1 = ctx.createRadialGradient(VW / 2, VH * 0.4, 0, VW / 2, VH * 0.4, VH * 0.95);
      bg1.addColorStop(0, "#0b0f26");
      bg1.addColorStop(1, "#05070f");
      ctx.fillStyle = bg1;
      ctx.fillRect(0, 0, VW, VH);
      if (p2 > 0) {
        const bg2 = ctx.createRadialGradient(VW / 2, VH * 0.35, 0, VW / 2, VH * 0.35, VH * 0.95);
        bg2.addColorStop(0, "#0a1826");
        bg2.addColorStop(1, "#04070c");
        ctx.globalAlpha = p2;
        ctx.fillStyle = bg2;
        ctx.fillRect(0, 0, VW, VH);
        ctx.globalAlpha = 1;
      }
      // stars
      ctx.fillStyle = p2 > 0.5 ? "#9fc6e8" : "#e8ecff";
      for (const s of STARS) {
        ctx.globalAlpha = 0.5 + 0.5 * Math.abs(Math.sin(t * 0.001 + s.x));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // ground glow line
      const groundGrad = ctx.createLinearGradient(0, GROUND, 0, VH);
      groundGrad.addColorStop(0, p2 > 0.5 ? "rgba(74,168,255,0.18)" : "rgba(255,210,74,0.14)");
      groundGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = groundGrad;
      ctx.fillRect(0, GROUND, VW, VH - GROUND);
      ctx.strokeStyle = p2 > 0.5 ? "rgba(120,190,255,0.5)" : "rgba(255,210,74,0.45)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, GROUND);
      ctx.lineTo(VW, GROUND);
      ctx.stroke();

      // ── ACT 1 — TOP CANVASSERS ──────────────────────────────────────────
      const outP = clamp01((t - tl.T_ACT1_OUT) / 400);
      if (outP < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - outP;
        ctx.translate(0, 56 * outP * outP);

        const titleGrad = ctx.createLinearGradient(0, 40, 0, 80);
        titleGrad.addColorStop(0, "#fff3c4");
        titleGrad.addColorStop(0.6, GOLD);
        titleGrad.addColorStop(1, GOLD_DEEP);
        popText(ctx, "TOP CANVASSERS", VW / 2, 64, tl.T_TITLE, t, 40, titleGrad, "#ffb02a");
        if (dateLabel)
          popText(ctx, `${dateLabel} · DAY RECAP`, VW / 2, 94, tl.T_TITLE + 140, t, 13, "#9fb2d8", "rgba(0,240,255,0.6)");

        if (winners.length === 0) {
          popText(ctx, "NO LEADS ON THE BOARD", VW / 2, 190, 800, t, 24, "#9fb2d8", "rgba(0,240,255,0.5)");
        }

        winners.forEach((w, i) => {
          const slot = SLOTS[i];
          const s = easeOutBack(clamp01((t - tl.popAt(i)) / 260));
          if (s <= 0.01) return;
          ctx.save();
          ctx.translate(slot.cx, GROUND);
          ctx.scale(s, s);
          // shadow pool
          ctx.fillStyle = "rgba(0,0,0,0.45)";
          ctx.beginPath();
          ctx.ellipse(0, 4, slot.w * 0.46, 9, 0, 0, Math.PI * 2);
          ctx.fill();
          // card body
          const g = ctx.createLinearGradient(0, -slot.h, 0, 0);
          g.addColorStop(0, slot.tone[0]);
          g.addColorStop(0.55, slot.tone[1]);
          g.addColorStop(1, slot.tone[2]);
          ctx.fillStyle = g;
          ctx.strokeStyle = "rgba(5,7,15,0.85)";
          ctx.lineWidth = 3;
          rr(ctx, -slot.w / 2, -slot.h, slot.w, slot.h, 12);
          ctx.fill();
          ctx.stroke();
          // crown on #1
          if (i === 0) {
            ctx.fillStyle = GOLD;
            ctx.strokeStyle = GOLD_DEEP;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-22, -slot.h - 20);
            ctx.lineTo(-22, -slot.h - 38);
            ctx.lineTo(-11, -slot.h - 27);
            ctx.lineTo(0, -slot.h - 44);
            ctx.lineTo(11, -slot.h - 27);
            ctx.lineTo(22, -slot.h - 38);
            ctx.lineTo(22, -slot.h - 20);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
          // rank badge
          ctx.fillStyle = "#0b0f26";
          ctx.strokeStyle = slot.tone[1];
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(0, -slot.h, 16, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = slot.tone[1];
          ctx.font = '900 18px "Arial Black", "Helvetica Neue", sans-serif';
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(i + 1), 0, -slot.h + 1);
          // name (fitted)
          const nm = w.name.toUpperCase();
          fitFont(ctx, nm, slot.w - 26, i === 0 ? 19 : 16);
          ctx.fillStyle = slot.ink;
          ctx.fillText(nm, 0, -slot.h + 44);
          // lead count, ticking up from this card's own pop
          const cp = easeInOut(clamp01((t - tl.popAt(i) - 120) / 600));
          const shown = Math.max(1, Math.round(w.leads * cp));
          ctx.font = `900 ${i === 0 ? 26 : 21}px "Arial Black", "Helvetica Neue", sans-serif`;
          ctx.fillText(`${shown} LEAD${shown === 1 ? "" : "S"}`, 0, -34);
          ctx.restore();
        });

        // confetti (Act 1 layer so it fades out with the podium)
        for (const c of confetti) {
          ctx.save();
          ctx.translate(c.x, c.y);
          ctx.rotate(c.rot);
          ctx.fillStyle = c.c;
          ctx.fillRect(-c.w / 2, -c.h / 2, c.w, c.h);
          ctx.restore();
        }

        // gleam sweep across the podium
        const gp = t - tl.T_SHINE;
        if (winners.length > 0 && gp > 0 && gp < 260) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(VW / 2 - 300, GROUND - 200, 600, 200);
          ctx.clip();
          ctx.globalCompositeOperation = "lighter";
          const gx = VW / 2 - 300 + 660 * (gp / 260) - 30;
          const gl = ctx.createLinearGradient(gx - 20, 0, gx + 20, 0);
          gl.addColorStop(0, "rgba(255,255,255,0)");
          gl.addColorStop(0.5, "rgba(255,255,255,0.5)");
          gl.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = gl;
          ctx.save();
          ctx.translate(gx, GROUND - 100);
          ctx.rotate(-0.35);
          ctx.fillRect(-24, -220, 48, 440);
          ctx.restore();
          ctx.restore();
        }
        ctx.restore();
      }

      // ── ACT 2 — THE DOUGHNUT ZONE ───────────────────────────────────────
      if (t >= tl.T_ACT2) {
        popText(ctx, "THE DOUGHNUT ZONE", VW / 2, 64, tl.T_ACT2, t, 34, ICE, ICE_GLOW);

        // 🍩 rain (behind the chips)
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (const p of drops) {
          if (!p.spawned) continue;
          const sq = p.squashAt >= 0 ? Math.max(0, 1 - (simT - p.squashAt) / 130) : 0;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(1 + 0.3 * sq, 1 - 0.35 * sq);
          ctx.globalAlpha = 0.9;
          ctx.font = `${p.size}px sans-serif`;
          ctx.fillText("🍩", 0, 0);
          ctx.restore();
        }
        ctx.globalAlpha = 1;

        if (donuts.length > 0) {
          for (let i = 0; i < tl.chipCount; i++) {
            const s = easeOutBack(clamp01((t - (tl.T_NAMES + i * CHIP_STEP)) / 220));
            if (s <= 0.01) continue;
            const overflow = donuts.length > MAX_CHIP_NAMES && i === tl.chipCount - 1;
            const d = overflow ? null : donuts[i];
            ctx.save();
            ctx.translate(CHIP_XS[i % 3], CHIP_YS[Math.floor(i / 3)]);
            ctx.scale(s, s);
            ctx.fillStyle = "rgba(6,10,18,0.85)";
            ctx.strokeStyle = overflow ? ICE : d?.frozen ? "#7d92a8" : "#ffb02a";
            ctx.lineWidth = 2;
            if (overflow) ctx.setLineDash([5, 4]);
            if (!overflow && !d?.frozen) {
              ctx.shadowColor = "rgba(255,176,42,0.55)";
              ctx.shadowBlur = 12;
            }
            rr(ctx, -CHIP_W / 2, -CHIP_H / 2, CHIP_W, CHIP_H, 10);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.setLineDash([]);
            const label = overflow
              ? `+${donuts.length - MAX_CHIP_NAMES} MORE 🍩`
              : `🍩 ${d!.name.toUpperCase()}${d!.frozen ? " ❄" : ""}`;
            fitFont(ctx, label, CHIP_W - 22, 13);
            ctx.fillStyle = overflow ? ICE : d?.frozen ? "#93a7bd" : "#ffe9c2";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, 0, 1);
            ctx.restore();
          }
          popText(ctx, "0 LEADS · CLOCKED IN", VW / 2, 298, tl.T_TAG, t, 13, "#93a7bd", "rgba(74,168,255,0.5)");
        } else {
          // everyone scored — punt the lone doughnut off screen
          popText(ctx, "ZERO DOUGHNUTS!", VW / 2, 160, tl.T_ACT2 + 350, t, 34, GOLD, "#ffb02a");
          popText(ctx, "EVERYONE SCORED", VW / 2, 198, tl.T_ACT2 + 520, t, 16, ICE, ICE_GLOW);
          const pr = clamp01((t - tl.T_TAG) / 800);
          if (pr > 0 && pr < 1) {
            ctx.save();
            ctx.translate(250 + 460 * pr, 258 - 140 * Math.sin(pr * Math.PI));
            ctx.rotate(pr * 5);
            ctx.font = "30px sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("🍩", 0, 0);
            ctx.restore();
          }
        }
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Hard stop no matter what rAF does (backgrounded tab etc.)
    const failsafe = hold == null ? window.setTimeout(finish, tl.DURATION + 400) : undefined;
    return () => {
      cancelAnimationFrame(raf);
      if (failsafe) window.clearTimeout(failsafe);
    };
  }, [phase, hold, markSeen, finish]);

  // Skip on any tap or key.
  useEffect(() => {
    if (phase !== "playing" || hold != null) return;
    const skip = () => finish();
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [phase, hold, finish]);

  if (phase !== "playing") return null;

  return (
    <div
      role="presentation"
      onPointerDown={hold == null ? finish : undefined}
      className="fixed inset-0 z-[10020] flex flex-col items-center justify-center select-none"
      style={{
        background: "radial-gradient(ellipse at 50% 40%, #0b0f26 0%, #05070f 70%)",
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease",
        cursor: "pointer",
      }}
    >
      <div
        className="font-display uppercase tracking-widest text-neon text-base sm:text-xl mb-4"
        style={{ textShadow: "0 0 14px color-mix(in oklab, var(--neon) 70%, transparent)" }}
      >
        End of Day
      </div>
      <div
        className="relative w-[min(92vw,720px)] overflow-hidden rounded-xl"
        style={{
          aspectRatio: "640 / 360",
          boxShadow:
            "0 0 40px -10px color-mix(in oklab, var(--neon) 45%, transparent), 0 24px 60px -20px rgba(0,0,0,0.9)",
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
      <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] text-[10px] font-display uppercase tracking-widest text-muted-foreground/70">
        Tap to skip ▸
      </div>
    </div>
  );
}
