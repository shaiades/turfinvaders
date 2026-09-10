import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * First-sign-in intro (owner ask 2026-09-10; restyled 2026-09-10 from 8-bit
 * pixels to an early-2000s look — smooth vector shapes, gradients/glow,
 * articulated run cycle, camera punch-ins, THPS-style pop text, NFS-style
 * van underglow): a ≤5s cutscene — the rep sprints out of the van, knocks
 * the door, and celebrates writing up a lead — played ONCE per account, the
 * first time they open the app signed in. Tap/keypress skips. Same seen-flag
 * scheme as the page tours: localStorage answers first, auth user_metadata
 * is the cross-device backstop (fire-and-forget). The flag is written when
 * playback STARTS so a mid-animation crash can never loop it.
 *
 * Preview/demo: `?welcome_anim=1` force-plays without writing any flag;
 * add `&welcome_hold=<ms>` to freeze the scene at that timestamp.
 * `prefers-reduced-motion` marks the flag and never plays (unless forced).
 *
 * Everything is drawn in-component on a 640×360 virtual canvas rendered at
 * device resolution — no image assets, no new dependencies.
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

/* ── Virtual scene space (uniformly scaled to the canvas) ──────────────── */

const VW = 640;
const VH = 360;
const GROUND = 300;
const DOOR_HINGE_X = 556;
const RUN_FROM = 175;
const RUN_TO = 530;

// Timeline (ms)
const T_RUN_START = 300;
const T_RUN_END = 2000;
const T_KNOCK_1 = 2050;
const T_KNOCK_2 = 2400;
const T_DOOR_OPEN = 2750;
const T_OWNER = 3050;
const T_CHEER = 3300;
const T_FADE_OUT = 4700;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOutBack = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

function rr(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number | number[],
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

const STARS = Array.from({ length: 26 }, (_, i) => ({
  x: (i * 53 + 21) % VW,
  y: ((i * 37 + 11) % 130) + 8,
  r: (i % 3) * 0.4 + 0.8,
}));

const FAR_BUILDINGS: Array<[number, number, number]> = [
  [0, 66, 236],
  [76, 44, 216],
  [132, 58, 226],
  [204, 40, 210],
  [256, 66, 232],
  [336, 46, 214],
  [396, 60, 228],
  [470, 40, 218],
];

const CONFETTI_COLORS = ["#ff2d92", "#00f0ff", "#39ff14", "#ffd93d", "#a855f7"];

type Confetto = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  c: string;
  w: number;
  h: number;
};

function spawnConfetti(list: Confetto[], cx: number, cy: number, n: number) {
  for (let i = 0; i < n; i++) {
    list.push({
      x: cx + (Math.random() - 0.5) * 70,
      y: cy + (Math.random() - 0.5) * 20,
      vx: (Math.random() - 0.5) * 4.4,
      vy: -(2.4 + Math.random() * 4.4),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.35,
      c: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      w: 3 + Math.random() * 3,
      h: 6 + Math.random() * 5,
    });
  }
}

/* ── Best-effort bleeps (silent unless the context is allowed) ─────────── */

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

/* ── Characters (articulated capsule figures) ──────────────────────────── */

function limb(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  len: number,
  w: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.fillStyle = color;
  rr(ctx, -w / 2, 0, w, len, w / 2);
  ctx.fill();
  ctx.restore();
}

type Pose = "stand" | "run" | "knock" | "cheer";

/** The rep, feet anchored at (x, y), facing right. ~64 virtual px tall. */
function drawRep(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, pose: Pose) {
  const ph = t * 0.021; // run cycle phase
  const running = pose === "run";
  const bob = running ? Math.abs(Math.sin(ph)) * 3.5 : 0;
  const lean = running ? -0.16 : pose === "cheer" ? 0.02 * Math.sin(t / 90) : 0;

  ctx.save();
  ctx.translate(x, y - bob);
  ctx.rotate(lean);

  const hipY = -28;
  const shoulderY = -48;

  // Legs
  const legSwing = running ? Math.sin(ph) * 0.85 : 0;
  const pants = "#2c3a66";
  if (pose === "cheer") {
    limb(ctx, -4, hipY, 0.14, 28, 9, pants);
    limb(ctx, 5, hipY, -0.14, 28, 9, pants);
  } else if (pose === "knock" || pose === "stand") {
    limb(ctx, -4, hipY, 0.08, 28, 9, pants);
    limb(ctx, 5, hipY, -0.05, 28, 9, pants);
  } else {
    limb(ctx, 0, hipY, legSwing + 0.2, 28, 9, pants);
    limb(ctx, 1, hipY, -legSwing + 0.2, 28, 9, pants);
  }
  // Shoes
  ctx.fillStyle = "#10131f";
  if (running) {
    const fx = Math.sin(ph) * 13;
    rr(ctx, -8 + fx, -4, 13, 5, 2.5);
    ctx.fill();
    rr(ctx, -6 - fx, -4, 13, 5, 2.5);
    ctx.fill();
  } else {
    rr(ctx, -9, -4, 13, 5, 2.5);
    ctx.fill();
    rr(ctx, 1, -4, 13, 5, 2.5);
    ctx.fill();
  }

  // Torso — neon cyan jersey with a soft vertical sheen
  const jersey = ctx.createLinearGradient(0, shoulderY - 6, 0, hipY);
  jersey.addColorStop(0, "#5ff7ff");
  jersey.addColorStop(0.45, "#00e0f2");
  jersey.addColorStop(1, "#00a8c2");
  ctx.fillStyle = jersey;
  rr(ctx, -9, shoulderY - 5, 19, 29, 9);
  ctx.fill();

  // Arms
  const skin = "#ffc79c";
  const armSwing = running ? Math.sin(ph + Math.PI) * 0.9 : 0;
  if (pose === "cheer") {
    const pump = Math.sin(t / 90) * 0.18;
    limb(ctx, -7, shoulderY, Math.PI * 0.78 + pump, 24, 7.5, "#00cfe4");
    limb(ctx, 8, shoulderY, -Math.PI * 0.78 - pump, 24, 7.5, "#00cfe4");
    ctx.fillStyle = skin; // fists in the air
    ctx.beginPath();
    ctx.arc(-24, shoulderY - 16 + pump * 8, 4.4, 0, Math.PI * 2);
    ctx.arc(25, shoulderY - 16 - pump * 8, 4.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (pose === "knock") {
    limb(ctx, -6, shoulderY, 0.35, 24, 7.5, "#00cfe4");
    // Knocking arm: horizontal, with a quick jab on each knock window
    const k1 = clamp01((t - T_KNOCK_1) / 180);
    const k2 = clamp01((t - T_KNOCK_2) / 180);
    const jab =
      (k1 > 0 && k1 < 1 ? Math.sin(k1 * Math.PI) : 0) +
      (k2 > 0 && k2 < 1 ? Math.sin(k2 * Math.PI) : 0);
    limb(ctx, 6, shoulderY + 2, -Math.PI / 2 + 0.12 - jab * 0.1, 25 + jab * 5, 7.5, "#00cfe4");
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.arc(33 + jab * 5, shoulderY - 1, 4.6, 0, Math.PI * 2);
    ctx.fill();
  } else {
    limb(ctx, -6, shoulderY, armSwing, 24, 7.5, "#00cfe4");
    limb(ctx, 7, shoulderY, -armSwing, 24, 7.5, "#00cfe4");
  }

  // Head + pink cap
  const headY = shoulderY - 15;
  ctx.fillStyle = skin;
  ctx.beginPath();
  ctx.arc(1, headY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff2d92";
  ctx.beginPath();
  ctx.arc(1, headY - 1.5, 10, Math.PI, 0);
  ctx.fill();
  rr(ctx, 3, headY - 5.5, 13, 4, 2); // brim, facing right
  ctx.fill();
  ctx.fillStyle = "#10131f"; // eye
  ctx.beginPath();
  ctx.arc(6.5, headY + 1.5, 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Homeowner in the doorway — soft purple robe, mug of coffee energy. */
function drawOwner(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  const robe = ctx.createLinearGradient(0, -46, 0, 0);
  robe.addColorStop(0, "#b06ff7");
  robe.addColorStop(1, "#7c3ac9");
  ctx.fillStyle = robe;
  rr(ctx, -11, -44, 22, 44, 8);
  ctx.fill();
  ctx.fillStyle = "#ffc79c";
  ctx.beginPath();
  ctx.arc(0, -52, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#cbd5e1"; // hair
  ctx.beginPath();
  ctx.arc(0, -54, 9, Math.PI, 0);
  ctx.fill();
  ctx.fillStyle = "#10131f";
  ctx.beginPath();
  ctx.arc(-3, -51, 1.2, 0, Math.PI * 2);
  ctx.arc(3, -51, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ── Pop text (THPS-style score callouts) ──────────────────────────────── */

function popText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  born: number,
  t: number,
  size: number,
  fill: string | CanvasGradient,
  glow: string,
) {
  const age = t - born;
  if (age < 0) return;
  const scale = easeOutBack(clamp01(age / 220));
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.07);
  ctx.scale(scale, scale);
  ctx.font = `900 italic ${size}px "Arial Black", "Helvetica Neue", sans-serif`;
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.shadowColor = glow;
  ctx.shadowBlur = 16;
  ctx.strokeStyle = "rgba(5,7,15,0.9)";
  ctx.lineWidth = 7;
  ctx.strokeText(text, 0, 0);
  ctx.shadowBlur = 0;
  ctx.fillStyle = fill;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/* ── Scene renderer ────────────────────────────────────────────────────── */

function drawScene(ctx: CanvasRenderingContext2D, t: number, confetti: Confetto[]) {
  // Dusk sky
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, "#080b22");
  sky.addColorStop(0.55, "#231447");
  sky.addColorStop(0.85, "#4b1a5e");
  sky.addColorStop(1, "#8a2668");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VW, VH);

  // Moon with bloom
  const moon = ctx.createRadialGradient(150, 66, 4, 150, 66, 70);
  moon.addColorStop(0, "rgba(247,243,255,0.95)");
  moon.addColorStop(0.18, "rgba(230,220,255,0.55)");
  moon.addColorStop(1, "rgba(230,220,255,0)");
  ctx.fillStyle = moon;
  ctx.fillRect(60, 0, 190, 160);
  ctx.fillStyle = "#f7f3ff";
  ctx.beginPath();
  ctx.arc(150, 66, 17, 0, Math.PI * 2);
  ctx.fill();

  // Stars
  for (let i = 0; i < STARS.length; i++) {
    const s = STARS[i];
    ctx.globalAlpha = 0.25 + 0.6 * Math.abs(Math.sin(t / 500 + i * 1.7));
    ctx.fillStyle = i % 4 === 0 ? "#8ef4ff" : "#ffffff";
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Skyline — far layer drifts a touch for parallax life
  const drift = -10 * clamp01(t / DURATION);
  ctx.fillStyle = "#171c3d";
  for (const [bx, bw, by] of FAR_BUILDINGS) {
    ctx.fillRect(bx + drift, by, bw, GROUND - by);
  }
  ctx.fillStyle = "#ffd76b"; // a few lit windows
  ctx.globalAlpha = 0.65;
  for (let i = 0; i < FAR_BUILDINGS.length; i++) {
    const [bx, bw, by] = FAR_BUILDINGS[i];
    for (let k = 0; k < 3; k++) {
      if ((i * 7 + k * 5) % 4 === 0) continue;
      ctx.fillRect(bx + drift + 8 + k * ((bw - 20) / 3), by + 14 + ((i + k) % 3) * 18, 4, 6);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#10152e";
  [
    [40, 250, 74],
    [148, 262, 96],
    [286, 246, 60],
    [372, 258, 88],
  ].forEach(([bx, by, bw]) => ctx.fillRect(bx + drift * 0.5, by, bw, GROUND - by));

  // Neon turf strip
  const grass = ctx.createLinearGradient(0, GROUND, 0, GROUND + 12);
  grass.addColorStop(0, "#0f5c26");
  grass.addColorStop(1, "#06240f");
  ctx.fillStyle = grass;
  ctx.fillRect(0, GROUND, VW, 12);
  ctx.save();
  ctx.shadowColor = "#39ff14";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#39ff14";
  ctx.fillRect(0, GROUND - 1.5, VW, 2.5);
  ctx.restore();

  // Street
  const street = ctx.createLinearGradient(0, GROUND + 12, 0, VH);
  street.addColorStop(0, "#181d38");
  street.addColorStop(1, "#0a0d1d");
  ctx.fillStyle = street;
  ctx.fillRect(0, GROUND + 12, VW, VH - GROUND - 12);
  ctx.save();
  ctx.shadowColor = "#ff2d92";
  ctx.shadowBlur = 6;
  ctx.fillStyle = "#ff2d92";
  for (let x = 10; x < VW; x += 56) {
    rr(ctx, x, GROUND + 36, 26, 4, 2);
    ctx.fill();
  }
  ctx.restore();

  /* House */
  const doorOpen = clamp01((t - T_DOOR_OPEN) / 260);
  // Wall
  const wall = ctx.createLinearGradient(0, 226, 0, GROUND);
  wall.addColorStop(0, "#333c6b");
  wall.addColorStop(1, "#20264a");
  ctx.fillStyle = wall;
  rr(ctx, 488, 226, 144, GROUND - 226, [12, 12, 0, 0]);
  ctx.fill();
  // Roof with neon trim
  ctx.fillStyle = "#161b38";
  ctx.beginPath();
  ctx.moveTo(478, 228);
  ctx.lineTo(642, 228);
  ctx.lineTo(620, 202);
  ctx.lineTo(500, 202);
  ctx.closePath();
  ctx.fill();
  ctx.save();
  ctx.shadowColor = "#ff2d92";
  ctx.shadowBlur = 12;
  ctx.strokeStyle = "#ff2d92";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(500, 202);
  ctx.lineTo(620, 202);
  ctx.stroke();
  ctx.restore();
  // Window — lights on once the door opens
  if (doorOpen > 0) {
    ctx.save();
    ctx.shadowColor = "#ffd27a";
    ctx.shadowBlur = 24 * doorOpen;
    const lit = ctx.createLinearGradient(0, 248, 0, 284);
    lit.addColorStop(0, "#ffedb0");
    lit.addColorStop(1, "#ffc86b");
    ctx.fillStyle = lit;
    rr(ctx, 502, 248, 40, 36, 6);
    ctx.fill();
    ctx.restore();
  } else {
    ctx.fillStyle = "#122740";
    rr(ctx, 502, 248, 40, 36, 6);
    ctx.fill();
  }
  ctx.strokeStyle = "#171b38";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(522, 248);
  ctx.lineTo(522, 284);
  ctx.moveTo(502, 266);
  ctx.lineTo(542, 266);
  ctx.stroke();

  // Doorway + warm spill
  ctx.fillStyle = "#0d0903";
  rr(ctx, DOOR_HINGE_X, 236, 38, GROUND - 236, [5, 5, 0, 0]);
  ctx.fill();
  if (doorOpen > 0) {
    const spill = ctx.createRadialGradient(575, 268, 4, 575, 268, 85);
    spill.addColorStop(0, `rgba(255,222,140,${0.9 * doorOpen})`);
    spill.addColorStop(0.5, `rgba(255,200,110,${0.35 * doorOpen})`);
    spill.addColorStop(1, "rgba(255,200,110,0)");
    ctx.fillStyle = spill;
    ctx.fillRect(495, 200, 160, 140);
    // Light pool on the pavement
    ctx.fillStyle = `rgba(255,214,122,${0.16 * doorOpen})`;
    ctx.beginPath();
    ctx.ellipse(568, GROUND + 16, 58, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    if (t >= T_OWNER) drawOwner(ctx, 575, GROUND - 2, clamp01((t - T_OWNER) / 180));
  }
  // Door — swings open around its left hinge
  const shake1 = t >= T_KNOCK_1 && t < T_KNOCK_1 + 160 ? Math.sin((t - T_KNOCK_1) / 8) : 0;
  const shake2 = t >= T_KNOCK_2 && t < T_KNOCK_2 + 160 ? Math.sin((t - T_KNOCK_2) / 8) : 0;
  ctx.save();
  ctx.translate(DOOR_HINGE_X, 0);
  ctx.scale(Math.max(0.08, 1 - easeInOut(doorOpen) * 0.92), 1);
  ctx.rotate((shake1 + shake2) * 0.012);
  const wood = ctx.createLinearGradient(0, 236, 0, GROUND);
  wood.addColorStop(0, "#83583a");
  wood.addColorStop(1, "#4a2f1a");
  ctx.fillStyle = wood;
  rr(ctx, 0, 236, 38, GROUND - 236, [5, 5, 0, 0]);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.3)";
  ctx.lineWidth = 2;
  rr(ctx, 6, 244, 26, 22, 4);
  ctx.stroke();
  rr(ctx, 6, 272, 26, 20, 4);
  ctx.stroke();
  ctx.fillStyle = "#ffd93d";
  ctx.beginPath();
  ctx.arc(32, 270, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Porch light — on with the door
  ctx.fillStyle = doorOpen > 0 ? "#ffe9a8" : "#3a4066";
  ctx.save();
  if (doorOpen > 0) {
    ctx.shadowColor = "#ffd27a";
    ctx.shadowBlur = 14;
  }
  ctx.beginPath();
  ctx.arc(600, 230, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  /* Van — parked left, nose left, open rear doors toward the house */
  const idle = Math.sin(t / 300) * 0.8;
  ctx.save();
  ctx.translate(0, idle * 0.6);
  // NFS-style neon underglow
  ctx.save();
  ctx.shadowColor = "#00f0ff";
  ctx.shadowBlur = 28;
  ctx.fillStyle = `rgba(0,240,255,${0.35 + 0.12 * Math.sin(t / 180)})`;
  ctx.beginPath();
  ctx.ellipse(98, 302, 70, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  // Body
  const body = ctx.createLinearGradient(0, 236, 0, 298);
  body.addColorStop(0, "#ff4da6");
  body.addColorStop(0.5, "#ff2d92");
  body.addColorStop(1, "#b0005e");
  ctx.fillStyle = body;
  rr(ctx, 28, 236, 142, 60, 12);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)"; // roof sheen
  rr(ctx, 34, 240, 128, 9, 5);
  ctx.fill();
  // Windshield (left/front) + side window, with a diagonal reflection streak
  const glass = ctx.createLinearGradient(0, 246, 0, 268);
  glass.addColorStop(0, "#bdf6ff");
  glass.addColorStop(1, "#17b8d8");
  ctx.fillStyle = glass;
  rr(ctx, 34, 246, 32, 22, [8, 4, 4, 4]);
  ctx.fill();
  rr(ctx, 72, 246, 54, 20, 5);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  rr(ctx, 34, 246, 92, 22, 5);
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.save();
  ctx.translate(60, 246);
  ctx.rotate(0.5);
  ctx.fillRect(0, -10, 8, 50);
  ctx.translate(22, 0);
  ctx.fillRect(0, -10, 4, 50);
  ctx.restore();
  ctx.restore();
  // Open rear doors (dark interior)
  ctx.fillStyle = "#0a0c16";
  rr(ctx, 146, 244, 20, 50, [4, 8, 4, 4]);
  ctx.fill();
  ctx.fillStyle = "rgba(0,240,255,0.16)";
  rr(ctx, 148, 246, 16, 46, 4);
  ctx.fill();
  // Tail light
  ctx.save();
  ctx.shadowColor = "#ff2244";
  ctx.shadowBlur = 8;
  ctx.fillStyle = "#ff3355";
  rr(ctx, 164, 238, 5, 9, 2);
  ctx.fill();
  ctx.restore();
  // Decal
  ctx.save();
  ctx.translate(98, 288);
  ctx.transform(1, 0, -0.22, 1, 0, 0);
  ctx.font = '900 italic 15px "Arial Black", sans-serif';
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.fillText("TURF INVADERS", 0, 0);
  ctx.restore();
  // Wheels
  for (const wx of [62, 140]) {
    ctx.fillStyle = "#0c0f1a";
    ctx.beginPath();
    ctx.arc(wx, 298, 13, 0, Math.PI * 2);
    ctx.fill();
    const rim = ctx.createRadialGradient(wx - 2, 296, 1, wx, 298, 8);
    rim.addColorStop(0, "#e8eef8");
    rim.addColorStop(1, "#5a6478");
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(wx, 298, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1a2030";
    ctx.beginPath();
    ctx.arc(wx, 298, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  /* The rep */
  let repX = RUN_FROM;
  let repY = GROUND;
  let pose: Pose = "stand";
  if (t >= T_RUN_START && t < T_RUN_END) {
    const p = easeInOut(clamp01((t - T_RUN_START) / (T_RUN_END - T_RUN_START)));
    repX = RUN_FROM + (RUN_TO - RUN_FROM) * p;
    pose = "run";
    // Speed lines + dust
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.14)";
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      ctx.lineWidth = 2.5 - i * 0.4;
      ctx.beginPath();
      ctx.moveTo(repX - 34 - i * 16, GROUND - 46 + i * 12);
      ctx.lineTo(repX - 68 - i * 22, GROUND - 46 + i * 12);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(57,255,20,0.35)";
    for (let i = 0; i < 3; i++) {
      const dp = (t / 90 + i * 0.33) % 1;
      ctx.globalAlpha = (1 - dp) * 0.4;
      ctx.beginPath();
      ctx.arc(repX - 18 - dp * 26, GROUND - 3 - dp * 8, 2.5 + dp * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  } else if (t >= T_RUN_END && t < T_CHEER) {
    repX = RUN_TO;
    pose = "knock";
  } else if (t >= T_CHEER) {
    // Step left of the doorway so the lit window and homeowner stay visible
    repX = RUN_TO - 60;
    pose = "cheer";
    repY = GROUND - Math.abs(Math.sin((t - T_CHEER) / 190)) * 14;
  }
  // Contact shadow
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.beginPath();
  ctx.ellipse(repX, GROUND + 3, 16, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  drawRep(ctx, repX, repY, t, pose);

  /* Callouts */
  if (t >= T_KNOCK_1 && t < T_KNOCK_1 + 330) {
    popText(ctx, "KNOCK!", 560, 188, T_KNOCK_1, t, 26, "#ffffff", "#ff2d92");
  }
  if (t >= T_KNOCK_2 && t < T_KNOCK_2 + 330) {
    popText(ctx, "KNOCK KNOCK!", 488, 182, T_KNOCK_2, t, 24, "#ffffff", "#ff2d92");
  }

  /* Celebration layer */
  if (t >= T_CHEER) {
    // Radial flash right at the beat
    const flash = 1 - clamp01((t - T_CHEER) / 200);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.32})`;
      ctx.fillRect(0, 0, VW, VH);
    }
    // Confetti with glow + spin
    for (const c of confetti) {
      ctx.save();
      ctx.globalAlpha = t > 4400 ? Math.max(0, 1 - (t - 4400) / 500) : 1;
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.shadowColor = c.c;
      ctx.shadowBlur = 5;
      ctx.fillStyle = c.c;
      rr(ctx, -c.w / 2, -c.h / 2, c.w, c.h, 1.5);
      ctx.fill();
      ctx.restore();
    }
    // Sparkle stars
    for (let i = 0; i < 5; i++) {
      const sx = RUN_TO - 110 + i * 28;
      const sy = 176 + ((i * 37) % 54);
      const pulse = Math.max(0, Math.sin(t / 110 + i * 1.4));
      if (pulse <= 0.05) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = i % 2 ? "#fff8c8" : "#c8fbff";
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const r = k % 2 === 0 ? 6 : 2.2;
        const a = (k * Math.PI) / 4;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // "+1 LEAD!" — gradient pop, floating up
    const rise = clamp01((t - T_CHEER) / 1000);
    const grad = ctx.createLinearGradient(0, 160, 0, 200);
    grad.addColorStop(0, "#f6ff8a");
    grad.addColorStop(1, "#39ff14");
    popText(ctx, "+1 LEAD!", RUN_TO - 62, 210 - rise * 44, T_CHEER, t, 38, grad, "#39ff14");
  }
}

/** Camera: gentle push-in for life, impact shake on knocks, zoom punch on
 *  the celebration beat. */
function applyCamera(ctx: CanvasRenderingContext2D, t: number) {
  let zoom = 1 + 0.02 * clamp01(t / 4400);
  if (t >= T_CHEER) zoom += 0.06 * easeOutBack(clamp01((t - T_CHEER) / 380)) * 0.9;
  let sx = 0;
  let sy = 0;
  for (const k of [T_KNOCK_1, T_KNOCK_2]) {
    const dt = t - k;
    if (dt > 0 && dt < 220) {
      const a = (1 - dt / 220) * 3.2;
      sx += Math.sin(dt * 0.9) * a;
      sy += Math.cos(dt * 1.3) * a * 0.6;
    }
  }
  ctx.translate(VW / 2 + sx, VH * 0.62 + sy);
  ctx.scale(zoom, zoom);
  ctx.translate(-VW / 2, -VH * 0.62);
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

  // Playback: rAF timeline against the 640×360 virtual space, rendered at
  // device resolution for crisp vector shapes.
  useEffect(() => {
    if (phase !== "playing") return;
    markSeen(); // written at START so an interrupted run can't loop the intro
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

    beepRef.current = makeBeeper();
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
          beepRef.current?.(85, 80, 0, "triangle");
        }
        if (t >= T_KNOCK_2 && !knock2Done) {
          knock2Done = true;
          beepRef.current?.(85, 80, 0, "triangle");
          beepRef.current?.(85, 80, 130, "triangle");
        }
        if (t >= T_CHEER && !cheerDone) {
          cheerDone = true;
          spawnConfetti(confetti, RUN_TO - 60, 190, 70);
          beepRef.current?.(523, 90, 0);
          beepRef.current?.(659, 90, 90);
          beepRef.current?.(784, 110, 180);
          beepRef.current?.(1046, 170, 270);
          setShowWelcome(true);
        }
        if (t >= T_CHEER + 500 && !confetti2Done) {
          confetti2Done = true;
          spawnConfetti(confetti, 575, 210, 34);
        }
        for (const c of confetti) {
          c.x += c.vx;
          c.y += c.vy;
          c.vy += 0.13;
          c.rot += c.vr;
        }
        if (t >= T_FADE_OUT) setVisible(false);
        if (t >= DURATION) {
          finish();
          return;
        }
      } else if (t >= T_CHEER && confetti.length === 0) {
        spawnConfetti(confetti, RUN_TO - 60, 210, 60);
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.save();
      applyCamera(ctx, t);
      drawScene(ctx, t, confetti);
      ctx.restore();
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
        Turf Invaders
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
        {/* Soft vignette — no scanlines, this cabinet is from the 2000s */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.45) 100%)",
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
