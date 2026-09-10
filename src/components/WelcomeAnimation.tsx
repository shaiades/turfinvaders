import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * First-sign-in intro (owner ask 2026-09-10): a ≤5s arcade cutscene — the
 * rep sprints out of the van, knocks the door, and celebrates writing up a
 * lead — played ONCE per account, the first time they open the app signed
 * in. Tap/keypress skips. Same seen-flag scheme as the page tours:
 * localStorage answers first, auth user_metadata is the cross-device
 * backstop (fire-and-forget). The flag is written when playback STARTS so a
 * mid-animation crash can never loop it.
 *
 * Preview/demo: `?welcome_anim=1` force-plays without writing any flag;
 * add `&welcome_hold=<ms>` to freeze the scene at that timestamp.
 * `prefers-reduced-motion` marks the flag and never plays (unless forced).
 *
 * Everything is drawn in-component on a 320×180 logical canvas (scaled with
 * image-rendering:pixelated) — no image assets, no new dependencies.
 */

const DURATION = 5000;
const seenKey = (uid: string) => `ti_welcome_anim_v1:${uid}`;

type AnimMeta = { ti_welcome_anim?: string };

function readLocal(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return true; // can't persist "seen" → never loop the intro
  }
}

function writeLocal(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    /* private mode — the metadata write still covers us */
  }
}

/* ── Pixel sprites ─────────────────────────────────────────────────────── */

const PAL: Record<string, string> = {
  C: "#ff007a", // cap (turf pink)
  S: "#ffc79c", // skin
  H: "#00f0ff", // shirt (neon cyan)
  P: "#2c3a66", // pants
  K: "#0a0c16", // shoes / eyes
  R: "#a855f7", // homeowner robe
  G: "#cbd5e1", // homeowner hair
};

const RUN_A = [
  "..CCCC....",
  ".CCCCCC...",
  ".SSSSS....",
  ".SS.KS....",
  ".SSSSS....",
  "..HHHH....",
  ".HHHHHH...",
  "SHHHHHHS..",
  "..HHHH....",
  "..PPPP....",
  ".PP..PP...",
  "PP....PP..",
  "KK.....KK.",
];

const RUN_B = [
  "..CCCC....",
  ".CCCCCC...",
  ".SSSSS....",
  ".SS.KS....",
  ".SSSSS....",
  "..HHHH....",
  ".SHHHHS...",
  "..HHHH....",
  "..HHHH....",
  "..PPPP....",
  "..PPPP....",
  "...PP.....",
  "..KKK.....",
];

const KNOCK = [
  "..CCCC....",
  ".CCCCCC...",
  ".SSSSS....",
  ".SS.KS....",
  ".SSSSS....",
  "..HHHH....",
  ".HHHHHHSS.",
  "..HHHH....",
  "..HHHH....",
  "..PPPP....",
  "..P..P....",
  "..P..P....",
  ".KK..KK...",
];

const CHEER_A = [
  "S......S..",
  ".H....H...",
  "..CCCC....",
  "..CCCC....",
  ".SSSSSS...",
  ".SK..KS...",
  ".SSSSSS...",
  "..HHHH....",
  ".HHHHHH...",
  "..HHHH....",
  "..PPPP....",
  ".PP..PP...",
  ".KK..KK...",
];

const CHEER_B = [
  "..........",
  "SH....HS..",
  "..CCCC....",
  "..CCCC....",
  ".SSSSSS...",
  ".SK..KS...",
  ".SSSSSS...",
  "..HHHH....",
  ".HHHHHH...",
  "..HHHH....",
  "..PPPP....",
  ".PP..PP...",
  ".KK..KK...",
];

const OWNER = [
  "..GGGG....",
  ".GSSSSG...",
  ".SK..KS...",
  ".SSSSSS...",
  "..RRRR....",
  ".RRRRRR...",
  ".RRRRRR...",
  ".RRRRRR...",
  ".RRRRRR...",
  ".RR..RR...",
  ".KK..KK...",
];

function drawMap(ctx: CanvasRenderingContext2D, map: string[], x: number, y: number) {
  for (let r = 0; r < map.length; r++) {
    const row = map[r];
    for (let c = 0; c < row.length; c++) {
      const color = PAL[row[c]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(x + c, y + r, 1, 1);
      }
    }
  }
}

/* ── Scene constants (logical 320×180) ─────────────────────────────────── */

const W = 320;
const H = 180;
const GROUND = 150;
const DOOR_X = 290; // house door left edge
const GUY_STOP_X = 274; // where the run ends (fist reaches the door)
const GUY_START_X = 62; // just outside the van's rear door

// Timeline (ms)
const T_RUN_START = 300;
const T_RUN_END = 2000;
const T_KNOCK_1 = 2050;
const T_KNOCK_2 = 2400;
const T_DOOR_OPEN = 2750;
const T_OWNER = 3050;
const T_CHEER = 3300;
const T_FADE_OUT = 4700;

const STARS = Array.from({ length: 18 }, (_, i) => ({
  x: (i * 37 + 13) % W,
  y: ((i * 53 + 7) % 70) + 4,
}));

const CONFETTI_COLORS = ["#ff007a", "#00f0ff", "#39ff14", "#ffd93d", "#a855f7"];

type Confetto = { x: number; y: number; vx: number; vy: number; c: string; s: number };

function spawnConfetti(list: Confetto[], cx: number, cy: number, n: number) {
  for (let i = 0; i < n; i++) {
    list.push({
      x: cx + (Math.random() - 0.5) * 30,
      y: cy + (Math.random() - 0.5) * 8,
      vx: (Math.random() - 0.5) * 2.2,
      vy: -(1.2 + Math.random() * 2.2),
      c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      s: Math.random() < 0.5 ? 2 : 3,
    });
  }
}

/* ── Best-effort 8-bit bleeps (silent unless the context is allowed) ───── */

function makeBeeper() {
  let ctx: AudioContext | null = null;
  return (freq: number, durMs: number, delayMs = 0, type: OscillatorType = "square") => {
    try {
      ctx ??= new AudioContext();
      if (ctx.state !== "running") return;
      const t0 = ctx.currentTime + delayMs / 1000;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.04, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + durMs / 1000);
    } catch {
      /* audio is a garnish — never let it break the intro */
    }
  };
}

/* ── Scene renderer ────────────────────────────────────────────────────── */

function drawScene(ctx: CanvasRenderingContext2D, t: number, confetti: Confetto[]) {
  // Sky
  ctx.fillStyle = "#07091a";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < STARS.length; i++) {
    const s = STARS[i];
    ctx.globalAlpha = 0.35 + 0.55 * Math.abs(Math.sin(t / 400 + i));
    ctx.fillStyle = i % 3 === 0 ? "#00f0ff" : "#ffffff";
    ctx.fillRect(s.x, s.y, 1, 1);
  }
  ctx.globalAlpha = 1;

  // Distant skyline
  ctx.fillStyle = "#101532";
  [
    [0, 118, 34, 32],
    [40, 108, 22, 42],
    [70, 122, 30, 28],
    [108, 112, 20, 38],
    [134, 124, 26, 26],
    [168, 110, 18, 40],
    [192, 120, 28, 30],
  ].forEach(([x, y, w, h]) => ctx.fillRect(x, y, w, h));

  // Ground: neon turf line over dark grass, then street
  ctx.fillStyle = "#0d3b1c";
  ctx.fillRect(0, GROUND, W, 5);
  ctx.fillStyle = "#39ff14";
  ctx.fillRect(0, GROUND, W, 1);
  ctx.fillStyle = "#0c1024";
  ctx.fillRect(0, GROUND + 5, W, H - GROUND - 5);
  ctx.fillStyle = "#ff007a";
  for (let x = 6; x < W; x += 26) ctx.fillRect(x, GROUND + 16, 10, 2);

  // Van (parked left, rear door facing the house)
  ctx.fillStyle = "#b3005b";
  ctx.fillRect(8, 116, 60, 4); // roof
  ctx.fillStyle = "#ff007a";
  ctx.fillRect(8, 120, 60, 26); // body
  ctx.fillStyle = "#00f0ff";
  ctx.fillRect(14, 124, 14, 9); // windows
  ctx.fillRect(32, 124, 14, 9);
  ctx.fillStyle = "#0a0c16";
  ctx.fillRect(56, 122, 12, 24); // open rear doorway
  ctx.fillStyle = "#ffd93d";
  ctx.fillRect(8, 138, 3, 3); // tail light
  ctx.fillStyle = "#0a0c16"; // wheels
  ctx.fillRect(16, 144, 8, 8);
  ctx.fillRect(48, 144, 8, 8);
  ctx.fillStyle = "#8b93a7";
  ctx.fillRect(19, 147, 2, 2);
  ctx.fillRect(51, 147, 2, 2);
  ctx.fillStyle = "#ffffff";
  ctx.font = '5px "Press Start 2P", monospace';
  ctx.fillText("TI", 40, 143);

  // House
  ctx.fillStyle = "#232a4d";
  ctx.fillRect(252, 100, 64, 50); // wall
  ctx.fillStyle = "#161b38";
  ctx.fillRect(248, 94, 72, 6); // roof slabs
  ctx.fillRect(254, 88, 60, 6);
  ctx.fillStyle = "#ff007a";
  ctx.fillRect(248, 94, 72, 1); // neon trim
  // Window — lights on once the door opens
  ctx.fillStyle = t >= T_DOOR_OPEN ? "#ffe6a3" : "#0e2b3d";
  ctx.fillRect(260, 110, 16, 13);
  ctx.fillStyle = "#161b38";
  ctx.fillRect(267, 110, 2, 13);
  ctx.fillRect(260, 115, 16, 2);

  // Door (jitters on knocks, opens after)
  const doorShake =
    (t >= T_KNOCK_1 && t < T_KNOCK_1 + 120) || (t >= T_KNOCK_2 && t < T_KNOCK_2 + 120)
      ? t % 2 === 0
        ? 1
        : -1
      : 0;
  if (t < T_DOOR_OPEN) {
    ctx.fillStyle = "#6b4a2f";
    ctx.fillRect(DOOR_X + doorShake, 122, 14, 28);
    ctx.fillStyle = "#3d2a1a";
    ctx.fillRect(DOOR_X + 2 + doorShake, 125, 10, 10);
    ctx.fillStyle = "#ffd93d";
    ctx.fillRect(DOOR_X + 11 + doorShake, 137, 2, 2);
  } else {
    // Open doorway with warm light spilling out
    ctx.fillStyle = "#120d06";
    ctx.fillRect(DOOR_X, 122, 14, 28);
    ctx.fillStyle = "#ffe6a3";
    ctx.globalAlpha = 0.85;
    ctx.fillRect(DOOR_X + 1, 123, 12, 26);
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    ctx.moveTo(DOOR_X + 1, 149);
    ctx.lineTo(DOOR_X - 22, GROUND + 14);
    ctx.lineTo(DOOR_X + 18, GROUND + 14);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    // Swung-open door panel against the wall
    ctx.fillStyle = "#6b4a2f";
    ctx.fillRect(DOOR_X + 14, 122, 3, 28);
    if (t >= T_OWNER) drawMap(ctx, OWNER, DOOR_X + 2, 128);
  }

  // The rep
  let guyX = GUY_START_X;
  let guyY = GROUND - 13;
  let frame = RUN_A;
  if (t < T_RUN_START) {
    frame = RUN_B;
  } else if (t < T_RUN_END) {
    const p = (t - T_RUN_START) / (T_RUN_END - T_RUN_START);
    guyX = GUY_START_X + (GUY_STOP_X - GUY_START_X) * p;
    frame = Math.floor(t / 90) % 2 === 0 ? RUN_A : RUN_B;
    // Kicked-up turf dust
    ctx.fillStyle = "#39ff14";
    ctx.globalAlpha = 0.5;
    ctx.fillRect(Math.round(guyX) - 3, GROUND - 2, 2, 1);
    ctx.fillRect(Math.round(guyX) - 6, GROUND - 1, 2, 1);
    ctx.globalAlpha = 1;
  } else if (t < T_CHEER) {
    guyX = GUY_STOP_X;
    const knocking =
      (t >= T_KNOCK_1 && t < T_KNOCK_1 + 200) || (t >= T_KNOCK_2 && t < T_KNOCK_2 + 200);
    frame = knocking ? KNOCK : RUN_B;
  } else {
    guyX = GUY_STOP_X - 6;
    frame = Math.floor(t / 160) % 2 === 0 ? CHEER_A : CHEER_B;
    const hop = Math.abs(Math.sin((t - T_CHEER) / 180)) * 4;
    guyY = GROUND - 13 - hop;
  }
  drawMap(ctx, frame, Math.round(guyX), Math.round(guyY));

  // Knock bubble — floats clear of the roofline, tail pointing at the door
  if ((t >= T_KNOCK_1 && t < T_KNOCK_1 + 300) || (t >= T_KNOCK_2 && t < T_KNOCK_2 + 300)) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(240, 70, 56, 13);
    ctx.fillRect(288, 83, 4, 4);
    ctx.fillStyle = "#0a0c16";
    ctx.font = '6px "Press Start 2P", monospace';
    ctx.fillText("KNOCK!", 246, 80);
  }

  // Confetti + floating score
  if (t >= T_CHEER) {
    for (const c of confetti) {
      ctx.fillStyle = c.c;
      ctx.globalAlpha = t > 4400 ? Math.max(0, 1 - (t - 4400) / 500) : 1;
      ctx.fillRect(Math.round(c.x), Math.round(c.y), c.s, c.s);
    }
    ctx.globalAlpha = 1;
    const rise = Math.min(1, (t - T_CHEER) / 900);
    const ty = 112 - rise * 26;
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.fillStyle = "#0a0c16";
    ctx.fillText("+1 LEAD", 233, ty + 1);
    ctx.fillText("+1 LEAD", 235, ty + 1);
    ctx.fillStyle = "#39ff14";
    ctx.fillText("+1 LEAD", 234, ty);
  }
}

/* ── Component ─────────────────────────────────────────────────────────── */

export function WelcomeAnimation({
  userId,
  onActiveChange,
}: {
  userId: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const forced = params?.get("welcome_anim") === "1";
  const holdParam = forced ? params?.get("welcome_hold") : null;
  const hold = holdParam ? Math.min(DURATION - 1, Math.max(0, Number(holdParam) || 0)) : null;

  // "checking" holds the tutorial back (via onActiveChange) while the
  // cross-device seen-flag is confirmed — localStorage answers synchronously.
  const [phase, setPhase] = useState<"checking" | "playing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "playing";
    return readLocal(seenKey(userId)) ? "done" : "checking";
  });
  const [visible, setVisible] = useState(false); // drives the CSS fade
  const [showWelcome, setShowWelcome] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const confettiRef = useRef<Confetto[]>([]);
  const beepRef = useRef<ReturnType<typeof makeBeeper> | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    onActiveChange?.(phase !== "done");
  }, [phase, onActiveChange]);

  const markSeen = useCallback(() => {
    if (forced) return; // previews never burn the real first-open
    writeLocal(seenKey(userId));
    const patch: AnimMeta = { ti_welcome_anim: new Date().toISOString() };
    // Fire-and-forget cross-device backstop, same as the tours.
    supabase.auth.updateUser({ data: patch }).catch(() => {});
  }, [forced, userId]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase("done");
  }, []);

  // Decide whether to play: reduced motion never plays; metadata seen on
  // another device just records locally and stays hidden.
  useEffect(() => {
    if (phase !== "checking") return;
    let cancelled = false;
    (async () => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
        markSeen();
        if (!cancelled) finish();
        return;
      }
      const meta = await Promise.race([
        supabase.auth
          .getSession()
          .then(({ data }) => (data.session?.user?.user_metadata ?? {}) as AnimMeta),
        new Promise<AnimMeta>((resolve) => window.setTimeout(() => resolve({}), 1200)),
      ]).catch(() => ({}) as AnimMeta);
      if (cancelled) return;
      if (meta.ti_welcome_anim) {
        writeLocal(seenKey(userId));
        finish();
      } else {
        setPhase("playing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, userId, markSeen, finish]);

  // Playback: rAF timeline against a 320×180 logical canvas.
  useEffect(() => {
    if (phase !== "playing") return;
    markSeen(); // written at START so an interrupted run can't loop the intro
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      finish();
      return;
    }
    beepRef.current = makeBeeper();
    // Best-effort: have the pixel font ready before the first text draw.
    try {
      document.fonts?.load('8px "Press Start 2P"').catch(() => {});
    } catch {
      /* fallback font is fine */
    }
    setVisible(true);

    const start = performance.now();
    let raf = 0;
    let knock1Done = false;
    let knock2Done = false;
    let cheerDone = false;
    let confetti2Done = false;
    const confetti = confettiRef.current;
    confetti.length = 0;

    const step = (now: number) => {
      const t = hold ?? now - start;
      if (hold == null) {
        if (t >= T_KNOCK_1 && !knock1Done) {
          knock1Done = true;
          beepRef.current?.(95, 70);
        }
        if (t >= T_KNOCK_2 && !knock2Done) {
          knock2Done = true;
          beepRef.current?.(95, 70);
        }
        if (t >= T_CHEER && !cheerDone) {
          cheerDone = true;
          spawnConfetti(confetti, GUY_STOP_X, 96, 60);
          beepRef.current?.(523, 90, 0);
          beepRef.current?.(659, 90, 100);
          beepRef.current?.(784, 140, 200);
          setShowWelcome(true);
        }
        if (t >= T_CHEER + 500 && !confetti2Done) {
          confetti2Done = true;
          spawnConfetti(confetti, DOOR_X - 30, 100, 30);
        }
        for (const c of confetti) {
          c.x += c.vx;
          c.y += c.vy;
          c.vy += 0.07;
        }
        if (t >= T_FADE_OUT) setVisible(false);
        if (t >= DURATION) {
          finish();
          return;
        }
      } else if (t >= T_CHEER && confetti.length === 0) {
        spawnConfetti(confetti, GUY_STOP_X, 108, 50);
      }
      drawScene(ctx, t, confetti);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // Hard stop no matter what rAF does (backgrounded tab etc.)
    const failsafe = hold == null ? window.setTimeout(finish, DURATION + 250) : undefined;
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
        background: "#05070f",
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease",
        cursor: "pointer",
      }}
    >
      <div
        className="font-display uppercase tracking-widest text-neon text-base sm:text-xl mb-4"
        style={{ textShadow: "0 0 14px color-mix(in oklab, var(--neon) 70%, transparent)" }}
      >
        Turf Invaders
      </div>
      <div className="relative w-[min(92vw,640px)]" style={{ aspectRatio: "320 / 180" }}>
        <canvas
          ref={canvasRef}
          width={W}
          height={H}
          className="w-full h-full"
          style={{ imageRendering: "pixelated" }}
        />
        {/* CRT scanlines + vignette */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 3px), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.5) 100%)",
          }}
        />
      </div>
      <div
        className="font-display uppercase tracking-widest text-xs sm:text-sm mt-4 text-victory"
        style={{
          opacity: showWelcome ? 1 : 0,
          transition: "opacity 400ms ease",
          textShadow: "0 0 12px color-mix(in oklab, var(--victory) 70%, transparent)",
        }}
      >
        Welcome to the turf
      </div>
      <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] text-[10px] font-display uppercase tracking-widest text-muted-foreground/70">
        Tap to skip ▸
      </div>
    </div>
  );
}
