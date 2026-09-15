import { useCallback, useEffect, useRef, useState } from "react";
import { clamp01, drawCoin, easeInOut, easeOutBack, makeBeeper } from "./intro-fx";

/**
 * LEAD SECURED — the Doorstep Finisher. A ~2.2s full-screen fighting-game
 * finisher that plays the instant a canvasser's lead submit is detected
 * (owner ask 2026-09-14: "way cooler and video game like"): letterbox bars
 * slam in, converging speed lines charge, a jagged neon impact star
 * detonates under three escalating hit-stops, LEAD / SECURED slam in as
 * tilted money-gradient stamps, time dilates to 0.3x while a coin arc
 * fountains toward the piggy pill, then the stamp implodes INTO a coin that
 * launches at the piggy corner as the bars retract. `onDone` fires exactly
 * once at the end — ActiveRun then triggers the piggy burst + gold toast,
 * so the cutscene never draws its own receipt and never double-ka-chings.
 *
 * Skip is a COMPRESSED FAST-FORWARD, never a cancel: any tap jumps to the
 * coin-launch beat and plays the flight + bar-retract at ~1.3x, so a rep who
 * skips 100% of the time still gets coin-into-piggy + toast. The parent
 * gates on prefers-reduced-motion (this never mounts) and only mounts it
 * from the submitted-close callback — SSR never sees it.
 *
 * Same house rules as the intros: 2D canvas only, intro-fx primitives, dpr
 * capped, rAF hard-stops at done + unmount cleanup + failsafe timeout
 * (battery rule — reps run on battery all shift). Portrait virtual space
 * 360×640 cover-scaled to the screen; letterbox bars and flashes draw in
 * screen space so camera shake never moves the cinema frame.
 */

const VW = 360;
const VH = 640;
const DURATION = 2200;
const CX = VW / 2;
const STAMP_Y = VH * 0.46;

/* Beats (real ms). Hit-stops freeze the RENDER clock just after each slam
 * lands; the real clock keeps driving input, SFX, and the failsafe. */
const T_HIT = 300;
const T_LEAD = 520;
const T_SECURED = 700;
const T_SLOWMO = 790; // 0.3x physics until T_SNAP
const T_COINS = 820; // coin arc fountains through the hold
const T_SNAP = 1550; // time whips back to 1x
const T_IMPLODE = 1650; // stamp collapses into a coin
const T_LAUNCH = 1800; // coin flies at the piggy corner
const T_BARS_OUT = 1900; // letterbox retracts, bg fades to the live app
const FREEZES: Array<[number, number]> = [
  [T_HIT + 30, T_HIT + 75],
  [T_LEAD + 30, T_LEAD + 100],
  [T_SECURED + 30, T_SECURED + 90],
];

const PINK = "#ff2d92";
const CYAN = "#00f0ff";
const GREEN = "#39ff14";

type Ember = { x: number; y: number; vx: number; vy: number; c: string; born: number };
type ArcCoin = { x: number; y: number; vx: number; vy: number; r: number; spin: number; born: number; dead: number };

/** SFX table — makeBeeper vocabulary, fired lazily as the clock crosses
 *  each beat so a skip naturally silences everything still unplayed. */
const SFX: Array<{ ms: number; f: number; d: number; t: OscillatorType }> = [
  // riser ladder → lands exactly on the hit
  { ms: 60, f: 160, d: 50, t: "sawtooth" },
  { ms: 105, f: 200, d: 50, t: "sawtooth" },
  { ms: 150, f: 250, d: 50, t: "sawtooth" },
  { ms: 195, f: 320, d: 50, t: "sawtooth" },
  { ms: 240, f: 420, d: 60, t: "sawtooth" },
  // THE HIT: sub thud + body + knuckle click
  { ms: T_HIT, f: 55, d: 120, t: "square" },
  { ms: T_HIT, f: 110, d: 80, t: "sawtooth" },
  { ms: T_HIT, f: 2200, d: 18, t: "square" },
  // LEAD slam: C2/G1 power dyad + glass-crack tick
  { ms: T_LEAD, f: 49, d: 150, t: "square" },
  { ms: T_LEAD, f: 98, d: 120, t: "square" },
  { ms: T_LEAD, f: 65.41, d: 130, t: "sawtooth" },
  { ms: T_LEAD, f: 1760, d: 22, t: "square" },
  // SECURED slam: same voicing a step up — call and answer
  { ms: T_SECURED, f: 55, d: 150, t: "square" },
  { ms: T_SECURED, f: 110, d: 120, t: "square" },
  { ms: T_SECURED, f: 73.42, d: 130, t: "sawtooth" },
  { ms: T_SECURED, f: 1976, d: 22, t: "square" },
  // slow-mo dive
  { ms: T_SLOWMO, f: 880, d: 70, t: "triangle" },
  { ms: 860, f: 659.25, d: 80, t: "triangle" },
  { ms: 940, f: 440, d: 110, t: "triangle" },
  // coin-arc blips riding the fountain
  { ms: 900, f: 1318.51, d: 45, t: "triangle" },
  { ms: 1040, f: 1567.98, d: 45, t: "triangle" },
  { ms: 1180, f: 1318.51, d: 45, t: "triangle" },
  // lone sub-bass heartbeat in the K.O. hold
  { ms: 1150, f: 41.2, d: 90, t: "square" },
  // snap-back whip — the dive inverted
  { ms: T_SNAP, f: 440, d: 40, t: "triangle" },
  { ms: 1595, f: 659.25, d: 40, t: "triangle" },
  { ms: 1640, f: 880, d: 55, t: "triangle" },
];
/** The canonical B5→E6 arcade coin — fired at launch on both paths. */
const SFX_COIN: Array<{ f: number; d: number; delay: number; t: OscillatorType }> = [
  { f: 987.77, d: 60, delay: 0, t: "square" },
  { f: 1318.5, d: 200, delay: 60, t: "square" },
];

/** Deterministic per-mount pseudo-random (no reseed across renders). */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function LeadStrikeFx({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const doneRef = useRef(false);
  const skipRef = useRef<number | null>(null); // real-ms when compressed skip began
  const [fading, setFading] = useState(false);

  // onDone rides a ref so `finish` (and the playback effect keyed on it) is
  // stable for the life of the mount — ActiveRun re-renders every GPS tick,
  // and an inline onDone in the effect deps would restart the whole timeline
  // from t=0 on each one (review catch 2026-09-14). key={seq} still forces a
  // fresh timeline per submit.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const finish = useCallback(() => {
    if (doneRef.current) return; // skip, auto-end, failsafe all funnel here
    doneRef.current = true;
    onDoneRef.current();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      finish(); // canvas denied (ancient WebView) — reward still lands
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const cw = Math.round((canvas.clientWidth || VW) * dpr);
    const ch = Math.round((canvas.clientHeight || VH) * dpr);
    canvas.width = cw;
    canvas.height = ch;
    // Cover-fit the portrait virtual space; center the crop.
    const s = Math.max(cw / VW, ch / VH);
    const ox = (cw - VW * s) / 2;
    const oy = (ch - VH * s) / 2;
    const barH = ch * 0.14;

    const beep = makeBeeper(); // the submit tap IS the iOS unlock gesture
    const fired = new Set<number>();
    const rng = makeRng(0x1ead);

    // Speed-line field: 28 tapered triangles at seeded angles.
    const lines = Array.from({ length: 28 }, () => ({
      ang: rng() * Math.PI * 2,
      dist: 90 + rng() * 240,
      len: 40 + rng() * 90,
      w: 2 + rng() * 5,
      ph: rng(),
    }));
    const stars = Array.from({ length: 14 }, () => ({
      x: rng() * VW,
      y: rng() * VH,
      a: 0.08 + rng() * 0.2,
    }));
    // 12-point jagged impact star radii (outer/inner alternating).
    const starPts = Array.from({ length: 24 }, (_, i) =>
      i % 2 === 0 ? 0.92 + rng() * 0.16 : 0.38 + rng() * 0.14,
    );
    const embers: Ember[] = [];
    const coins: ArcCoin[] = [];
    let coinsSpawned = 0;
    let lastNow = performance.now();
    const start = lastNow;

    const spawnEmbers = (n: number, at: number) => {
      for (let i = 0; i < n; i++) {
        const a = rng() * Math.PI * 2;
        const sp = 2.5 + rng() * 4;
        embers.push({
          x: CX,
          y: STAMP_Y,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 1,
          c: [CYAN, PINK, GREEN][Math.floor(rng() * 3)],
          born: at,
        });
      }
    };

    /** Render clock: real vt with each hit-stop window clamped to its start. */
    const renderT = (vt: number) => {
      for (const [a, b] of FREEZES) if (vt >= a && vt < b) return a;
      return vt;
    };
    /** Physics rate: 0.3x through the slow-mo window. */
    const timeScale = (vt: number) => (vt >= T_SLOWMO && vt < T_SNAP ? 0.3 : 1);
    const shakeAt = (vt: number, at: number, amp: number) => {
      const dt = vt - at;
      if (dt <= 0 || dt >= 200) return [0, 0];
      const decay = 1 - dt / 200;
      return [Math.sin(dt * 0.9) * amp * decay, Math.cos(dt * 1.3) * amp * 0.6 * decay];
    };

    const drawStamp = (
      text: string,
      px: number,
      y: number,
      scale: number,
      alpha: number,
      ghost: number, // 0..1 chromatic ghost strength
    ) => {
      if (alpha <= 0 || scale <= 0) return;
      ctx.save();
      ctx.translate(CX, y);
      ctx.rotate(-0.07);
      ctx.scale(scale, scale);
      ctx.font = `900 italic ${px}px 'Arial Black', Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      if (ghost > 0) {
        ctx.globalCompositeOperation = "lighter";
        ctx.globalAlpha = 0.35 * ghost * alpha;
        ctx.fillStyle = CYAN;
        ctx.fillText(text, -2, 0);
        ctx.fillStyle = PINK;
        ctx.fillText(text, 2, 0);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = alpha;
      const grad = ctx.createLinearGradient(0, -px / 2, 0, px / 2);
      grad.addColorStop(0, "#f6ff8a");
      grad.addColorStop(1, GREEN);
      ctx.lineWidth = px / 9;
      ctx.strokeStyle = "#04140a";
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 16;
      ctx.strokeText(text, 0, 0);
      ctx.fillStyle = grad;
      ctx.fillText(text, 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };

    let raf = 0;
    const step = (now: number) => {
      const dt = Math.min(50, now - lastNow);
      lastNow = now;
      const real = now - start;
      // Compressed skip: jump to the coin launch, play it out at ~1.3x.
      const vt =
        skipRef.current !== null
          ? T_LAUNCH + (real - skipRef.current) * ((DURATION - T_LAUNCH) / 300)
          : real;
      if (vt >= DURATION) {
        finish();
        return; // rAF chain ends — never reschedule past done (battery rule)
      }
      // Fade only in the final beat — a skip still SHOWS its compressed
      // coin flight instead of fading it out from the first frame.
      if (vt >= DURATION - 200) setFading(true);
      if (skipRef.current === null) {
        for (const b of SFX) {
          if (vt >= b.ms && !fired.has(b.ms * 10000 + b.f)) {
            fired.add(b.ms * 10000 + b.f);
            try {
              beep(b.f, b.d, 0, b.t);
            } catch {
              /* audio is garnish */
            }
          }
        }
        if (vt >= T_LAUNCH && !fired.has(-1)) {
          fired.add(-1);
          for (const c of SFX_COIN) beep(c.f, c.d, c.delay, "square");
        }
      }
      const rt = renderT(vt);
      const ts = timeScale(vt);

      // ── Physics ────────────────────────────────────────────────────────
      const frozen = rt !== vt;
      if (!frozen) {
        const k = (dt / 16.7) * ts;
        for (const e of embers) {
          e.x += e.vx * k;
          e.y += e.vy * k;
          e.vy += 0.13 * k;
        }
        while (
          skipRef.current === null &&
          vt >= T_COINS + coinsSpawned * 45 &&
          coinsSpawned < 8
        ) {
          coinsSpawned++;
          coins.push({
            x: CX + 20,
            y: STAMP_Y + 60,
            vx: -(2.2 + rng() * 2.4),
            vy: -(5 + rng() * 2.5),
            r: 5 + rng() * 2,
            spin: rng() * Math.PI,
            born: vt,
            dead: 0,
          });
        }
        for (const c of coins) {
          if (c.dead) continue;
          c.x += c.vx * k;
          c.y += c.vy * k;
          c.vy += 0.16 * k;
          c.spin += 0.25 * k;
          if (c.y > VH * 0.8 || c.x < 8) c.dead = vt; // dies with a white ping
        }
      }

      // ── Screen-space ground: bg radial fades out as the app is revealed ─
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const bgA = vt < T_BARS_OUT ? 1 : 1 - easeInOut(clamp01((vt - T_BARS_OUT) / 250));
      if (bgA > 0) {
        ctx.globalAlpha = bgA;
        const bg = ctx.createRadialGradient(cw / 2, ch * 0.4, 0, cw / 2, ch * 0.4, ch * 0.75);
        bg.addColorStop(0, "#0b0f26");
        bg.addColorStop(1, "#05070f");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, cw, ch);
        ctx.globalAlpha = 1;
      }

      // ── Camera (virtual space) ─────────────────────────────────────────
      let zoom = 1 + 0.03 * clamp01(rt / T_HIT);
      const punch = (at: number, amt: number) => {
        const d = rt - at;
        if (d > 0 && d < 320) zoom += amt * (1 - easeInOut(clamp01(d / 320)));
      };
      punch(T_LEAD, 0.08);
      punch(T_SECURED, 0.06);
      if (rt >= T_SLOWMO && rt < T_SNAP)
        zoom += 0.05 * easeInOut(clamp01((rt - T_SLOWMO) / (T_SNAP - T_SLOWMO)));
      if (rt >= T_SNAP) {
        const d = rt - T_SNAP;
        zoom += d < 80 ? 0.05 - 0.07 * (d / 80) : d < 160 ? -0.02 * (1 - (d - 80) / 80) : 0;
      }
      let sx = 0;
      let sy = 0;
      for (const [at, amp] of [
        [T_HIT, 4],
        [T_LEAD, 7],
        [T_SECURED, 6],
      ] as const) {
        const [a, b] = shakeAt(vt, at, amp);
        sx += a;
        sy += b;
      }
      ctx.setTransform(s, 0, 0, s, ox, oy);
      ctx.translate(CX + sx, STAMP_Y + sy);
      ctx.scale(zoom, zoom);
      ctx.translate(-CX, -STAMP_Y);

      // faint turf-glow horizon + star specks
      if (bgA > 0) {
        ctx.globalAlpha = 0.12 * bgA;
        ctx.fillStyle = GREEN;
        ctx.fillRect(-40, VH * 0.78, VW + 80, 3);
        for (const st of stars) {
          ctx.globalAlpha = st.a * bgA;
          ctx.fillStyle = "#dfe9ff";
          ctx.fillRect(st.x, st.y, 1.6, 1.6);
        }
        ctx.globalAlpha = 1;
      }

      // ── Speed-line field: converge → burst → drift → gasp-in ───────────
      const mode =
        rt < T_HIT ? "in" : rt < T_SLOWMO ? "out" : rt < T_IMPLODE ? "drift" : "in";
      const lineA = mode === "drift" ? 0.08 : 0.1 + 0.15 * (mode === "in" ? 1 : 0.8);
      for (const L of lines) {
        const phase =
          mode === "in"
            ? 1 - ((rt * 0.004 + L.ph) % 1)
            : mode === "out"
              ? (rt * (rt < T_SLOWMO ? 0.004 : 0.0012) + L.ph) % 1
              : (rt * 0.0012 + L.ph) % 1;
        const d0 = 40 + phase * L.dist;
        const ax = Math.cos(L.ang);
        const ay = Math.sin(L.ang);
        ctx.globalAlpha = lineA * (mode === "in" ? phase : 1 - phase);
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.moveTo(CX + ax * d0 - ay * L.w * 0.5, STAMP_Y + ay * d0 + ax * L.w * 0.5);
        ctx.lineTo(CX + ax * d0 + ay * L.w * 0.5, STAMP_Y + ay * d0 - ax * L.w * 0.5);
        ctx.lineTo(CX + ax * (d0 + L.len), STAMP_Y + ay * (d0 + L.len));
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // ── Shockwave rings (white core + pink halo, additive) ─────────────
      ctx.globalCompositeOperation = "lighter";
      for (const at of [T_HIT, T_LEAD, T_SECURED]) {
        const age = rt - at;
        if (age <= 0 || age >= 450) continue;
        const p = easeInOut(clamp01(age / 450));
        const r = 20 + p * 260;
        const lw = 10 * (1 - p);
        if (lw < 0.4) continue;
        ctx.globalAlpha = 1 - p;
        ctx.lineWidth = lw;
        ctx.strokeStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(CX, STAMP_Y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = PINK;
        ctx.lineWidth = lw * 0.8;
        ctx.beginPath();
        ctx.arc(CX, STAMP_Y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;

      // ── Impact star: slam 4→1, hold through the freeze, collapse ───────
      if (rt >= T_HIT && rt < T_HIT + 160) {
        const slam = clamp01((rt - T_HIT) / 30);
        const die = clamp01((rt - T_HIT - 120) / 40);
        const sc = (4 - 3 * slam) * (1 - die * 0.6);
        const R = 100 * sc;
        ctx.globalAlpha = 1 - die;
        for (const [fill, k] of [
          [PINK, 1],
          ["#ffffff", 0.4],
        ] as const) {
          ctx.fillStyle = fill;
          ctx.beginPath();
          for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2 - Math.PI / 2;
            const rr2 = R * starPts[i] * k;
            const px = CX + Math.cos(a) * rr2;
            const py = STAMP_Y + Math.sin(a) * rr2;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      // telegraph cross-spark before the hit
      if (rt > 60 && rt < 240 && Math.floor(rt / 40) % 2 === 0) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(CX - 10, STAMP_Y);
        ctx.lineTo(CX + 10, STAMP_Y);
        ctx.moveTo(CX, STAMP_Y - 10);
        ctx.lineTo(CX, STAMP_Y + 10);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // ── Embers + coin arc ──────────────────────────────────────────────
      for (const [at, n] of [
        [T_HIT, 10],
        [T_LEAD, 14],
        [T_SECURED, 8],
      ] as const) {
        if (rt >= at && !fired.has(-at)) {
          fired.add(-at);
          spawnEmbers(n, vt);
        }
      }
      for (const e of embers) {
        const age = vt - e.born;
        if (age > 900) continue;
        ctx.globalAlpha = 1 - age / 900;
        ctx.fillStyle = e.c;
        ctx.fillRect(e.x, e.y, 3, 5);
      }
      ctx.globalAlpha = 1;
      for (const c of coins) {
        if (c.dead) {
          const age = vt - c.dead;
          if (age < 120) {
            ctx.globalAlpha = 1 - age / 120;
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(c.x, c.y, 3 + (age / 120) * 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
          continue;
        }
        ctx.save();
        ctx.translate(c.x, c.y);
        ctx.scale(Math.max(0.12, Math.abs(Math.cos(c.spin))), 1); // flip glint
        drawCoin(ctx, c.r);
        ctx.restore();
      }

      // ── Stamps: LEAD / SECURED — slam, breathe, squash, implode ────────
      const holdBreath =
        rt >= 1100 && rt < T_SNAP ? 1 + 0.03 * Math.sin(((rt - 1100) / 400) * Math.PI * 2) : 1;
      const squash = rt >= T_SNAP && rt < T_IMPLODE ? 0.85 + 0.15 * ((rt - T_SNAP) / 100) : 1;
      const implode = rt >= T_IMPLODE ? easeInOut(clamp01((rt - T_IMPLODE) / 150)) : 0;
      const group = holdBreath * Math.min(1, squash) * (1 - implode);
      const slamScale = (at: number) => {
        const d = rt - at;
        if (d < 0) return 0;
        if (d < 30) return 5 - 4 * (d / 30);
        if (d < 130) return 1 + 0.06 * Math.sin(((d - 30) / 100) * Math.PI); // overshoot tick
        return 1;
      };
      const ghostAmt = (at: number) => 1 - clamp01((vt - at - 30) / 90);
      if (rt >= T_LEAD && implode < 1) {
        drawStamp("LEAD", 64, STAMP_Y - 24, slamScale(T_LEAD) * group, 1, ghostAmt(T_LEAD));
        if (rt >= T_SECURED)
          drawStamp("SECURED", 44, STAMP_Y + 30, slamScale(T_SECURED) * group, 1, ghostAmt(T_SECURED));
      }

      // ── Implosion coin + launch toward the piggy corner ────────────────
      if (rt >= T_IMPLODE) {
        const grow = clamp01((rt - T_IMPLODE) / 150);
        if (rt < T_LAUNCH) {
          ctx.save();
          ctx.translate(CX, STAMP_Y);
          ctx.scale(Math.max(0.12, Math.abs(Math.cos(grow * Math.PI))), 1); // 180° flip
          drawCoin(ctx, 16 * grow);
          ctx.restore();
        } else {
          const p = easeInOut(clamp01((rt - T_LAUNCH) / 320));
          const tx = VW * 0.16;
          const ty = VH * 0.14; // the piggy pill lives at the map's top-left
          const mx = CX * 0.5;
          const my = STAMP_Y - 140;
          const bx = (1 - p) * (1 - p) * CX + 2 * (1 - p) * p * mx + p * p * tx;
          const by = (1 - p) * (1 - p) * STAMP_Y + 2 * (1 - p) * p * my + p * p * ty;
          ctx.globalCompositeOperation = "lighter";
          for (let i = 1; i <= 5; i++) {
            const q = clamp01(p - i * 0.06);
            const qx = (1 - q) * (1 - q) * CX + 2 * (1 - q) * q * mx + q * q * tx;
            const qy = (1 - q) * (1 - q) * STAMP_Y + 2 * (1 - q) * q * my + q * q * ty;
            ctx.globalAlpha = 0.3 * (1 - i / 6);
            ctx.fillStyle = i % 2 ? GREEN : "#ffb02a";
            ctx.fillRect(qx - 2, qy - 2, 4, 4);
          }
          ctx.globalCompositeOperation = "source-over";
          ctx.globalAlpha = 1;
          if (p < 1) {
            ctx.save();
            ctx.translate(bx, by);
            ctx.scale(Math.max(0.2, Math.abs(Math.cos(p * 6))), 1);
            drawCoin(ctx, 13 * (1 - p * 0.4));
            ctx.restore();
          }
        }
      }

      // ── Screen space: white flashes + letterbox bars ───────────────────
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const [at, a0] of [
        [T_HIT, 0.35],
        [T_LEAD, 0.25],
        [T_SECURED, 0.2],
      ] as const) {
        const d = vt - at;
        if (d > 0 && d < 70) {
          ctx.globalAlpha = a0 * (1 - d / 70);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, cw, ch);
        }
      }
      ctx.globalAlpha = 1;
      let barP = easeOutBack(clamp01(rt / 160));
      if (vt >= T_BARS_OUT) barP = 1 - easeInOut(clamp01((vt - T_BARS_OUT) / 250));
      if (barP > 0) {
        const h = barH * barP;
        ctx.fillStyle = "#05070f";
        ctx.fillRect(0, 0, cw, h);
        ctx.fillRect(0, ch - h, cw, h);
        ctx.fillStyle = PINK;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(0, h - 1, cw, 1);
        ctx.fillRect(0, ch - h, cw, 1);
        ctx.globalAlpha = 1;
      }

      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Hard stop no matter what rAF does (backgrounded-tab throttling).
    const failsafe = window.setTimeout(finish, DURATION + 600);
    const skip = () => {
      if (skipRef.current !== null) {
        finish(); // second tap: out immediately
        return;
      }
      const elapsed = performance.now() - start;
      if (elapsed >= T_LAUNCH) {
        // The coin is already flying — a "skip" here would rewind it and
        // double-fire the coin chirp. Just let go.
        finish();
        return;
      }
      skipRef.current = elapsed;
      try {
        for (const c of SFX_COIN) beep(c.f, c.d, c.delay, "square");
      } catch {
        /* garnish */
      }
    };
    window.addEventListener("keydown", skip);
    canvas.parentElement?.addEventListener("pointerdown", skip);
    return () => {
      cancelAnimationFrame(raf); // unmount kills the loop (battery rule)
      window.clearTimeout(failsafe);
      window.removeEventListener("keydown", skip);
      canvas.parentElement?.removeEventListener("pointerdown", skip);
    };
  }, [finish]);

  return (
    // z-[2100]: above the just-closed LeadSheet (z-[2000]) and all in-map
    // chrome (z-[1000..1002]); deliberately below the tutorial (10010),
    // intros (10020), and confetti (10500) — teach overlays and the eventual
    // toast outrank the flourish.
    <div
      role="presentation"
      className="fixed inset-0 z-[2100] select-none cursor-pointer"
      style={{ opacity: fading ? 0 : 1, transition: "opacity 200ms ease" }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      <div className="absolute inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] text-center text-[9px] font-display uppercase tracking-widest text-white/40 pointer-events-none">
        Tap to skip ▸
      </div>
    </div>
  );
}
