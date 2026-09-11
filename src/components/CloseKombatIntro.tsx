import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { clamp01, drawCoin, easeInOut, easeOutBack, limb, makeBeeper, popText, rr } from "./intro-fx";

/**
 * Sales-rep first-sign-in intro (owner ask 2026-09-10): sales reps live on
 * exactly one screen — Close Kombat — so instead of the van-arrival welcome
 * cutscene they get their own ≤5s fighting-game cold open. Same early-2000s
 * register as WelcomeAnimation (smooth vector shapes, gradients, glossy
 * highlights, pop text — no pixel/scanline art, owner call 2026-09-10), with
 * a modern cinematic grade on top (owner call 2026-09-10: "way more modern"):
 * saturated golden-hour sky, bloom + lens flare, lit windows, long shadows,
 * glow on every payday particle. The rep sprints up the lawn, FLYING-KICKS
 * the front door clean off its hinges, disappears inside to a KA-CHING, and
 * swaggers back out with a money bag over the shoulder while the homeowner
 * waves goodbye — a closed deal, Close Kombat style.
 *
 * Mechanics are identical to WelcomeAnimation: played once per account
 * (localStorage answers first, auth user_metadata is the cross-device
 * backstop; the flag is written when playback STARTS so a crash can't loop
 * it), tap/keypress skips, `prefers-reduced-motion` marks it seen unplayed.
 *
 * Preview/demo from ANY role: `?ck_anim=1` force-plays without writing any
 * flag; add `&ck_hold=<ms>` to freeze the scene at that timestamp.
 * Everything is drawn in-component on a 640×360 virtual canvas — no image
 * assets, no new dependencies.
 */

const DURATION = 5000;
const seenKey = (uid: string) => `ti_ck_intro_v1:${uid}`;

type AnimMeta = { ti_ck_intro?: string };

/** AppShell swaps the welcome intro for this one when the account is a sales
 *  rep — or whenever the preview param is on, so any role can screen it. */
export function isCloseKombatIntroForced(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("ck_anim") === "1";
}

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

// House front — face-on wall on the right, door dead ahead of the run line.
const DOOR_L = 538;
const DOOR_W = 44;
const DOOR_CX = DOOR_L + DOOR_W / 2;
const DOOR_TOP = 228;
const IMPACT_X = 544;
const IMPACT_Y = 260;

// The rep's marks
const RUN_FROM = 64;
const RUN_TO = 468; // where the run becomes the leap
const LAND_X = 506;
const ENTER_X = 554; // swallowed by the doorway
const WALK_TO = 238; // final pose spot

// Timeline (ms)
const T_FIGHT = 180;
const T_RUN_START = 300;
const T_LEAP = 1500;
const T_KICK = 1780;
const T_LAND = 2020;
const T_ENTER = 2120;
const T_KACHING = 2520;
const T_EXIT = 2720;
const T_WAVE = 3050;
const T_CLOSED = 3480;
const T_POSE = 4180;
const T_FADE_OUT = 4700;

/* ── Particles: door splinters, coins, fluttering bills ────────────────── */

type ParticleKind = "shard" | "coin" | "bill";

type Particle = {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  born: number;
};

const LIFE: Record<ParticleKind, number> = { shard: 800, coin: 1700, bill: 1600 };
const GRAV: Record<ParticleKind, number> = { shard: 0.3, coin: 0.24, bill: 0.045 };

function spawnShards(list: Particle[], t: number) {
  for (let i = 0; i < 9; i++) {
    list.push({
      kind: "shard",
      x: IMPACT_X + (Math.random() - 0.5) * 10,
      y: IMPACT_Y + (Math.random() - 0.5) * 26,
      vx: -(0.8 + Math.random() * 3.6),
      vy: -(0.5 + Math.random() * 3.8),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.5,
      size: 2.5 + Math.random() * 3,
      born: t,
    });
  }
}

function spawnCoins(list: Particle[], t: number, cx: number, cy: number, n: number, up = false) {
  for (let i = 0; i < n; i++) {
    list.push({
      kind: "coin",
      x: cx + (Math.random() - 0.5) * 18,
      y: cy + (Math.random() - 0.5) * 12,
      vx: up ? (Math.random() - 0.5) * 4.6 : -(0.4 + Math.random() * 3.2),
      vy: -(2.2 + Math.random() * (up ? 4.8 : 3.4)),
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      size: 3 + Math.random() * 2.2,
      born: t,
    });
  }
}

function spawnBill(list: Particle[], t: number, cx: number, cy: number, burst = false) {
  list.push({
    kind: "bill",
    x: cx + (Math.random() - 0.5) * (burst ? 26 : 8),
    y: cy + (Math.random() - 0.5) * 10,
    vx: burst ? (Math.random() - 0.5) * 3.6 : 0.3 + Math.random() * 0.5,
    vy: burst ? -(2 + Math.random() * 4.4) : -0.4 - Math.random() * 0.5,
    rot: (Math.random() - 0.5) * 0.8,
    vr: (Math.random() - 0.5) * 0.12,
    size: 3.4 + Math.random() * 1.6,
    born: t,
  });
}

function stepParticles(list: Particle[], t: number) {
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.vy += GRAV[p.kind];
    p.x += p.vx + (p.kind === "bill" ? Math.sin((t - p.born) / 190) * 0.7 : 0);
    p.y += p.vy;
    p.rot += p.vr;
    if (p.kind === "coin" && p.y > GROUND + 8 && p.vy > 0) {
      p.y = GROUND + 8;
      p.vy *= -0.48;
      p.vx *= 0.8;
    }
    if (t - p.born > LIFE[p.kind]) list.splice(i, 1);
  }
}

function drawParticles(ctx: CanvasRenderingContext2D, list: Particle[], t: number) {
  for (const p of list) {
    const fade = clamp01(1 - (t - p.born - LIFE[p.kind] * 0.6) / (LIFE[p.kind] * 0.4));
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    if (p.kind === "shard") {
      ctx.fillStyle = "#8a5a2b";
      rr(ctx, -p.size / 2, -p.size * 1.1, p.size, p.size * 2.2, 1);
      ctx.fill();
    } else if (p.kind === "coin") {
      drawCoin(ctx, p.size);
    } else {
      ctx.shadowColor = "#3ecf5a";
      ctx.shadowBlur = 4;
      ctx.fillStyle = "#3ecf5a";
      ctx.strokeStyle = "#1d8f37";
      ctx.lineWidth = 1;
      rr(ctx, -p.size * 1.3, -p.size * 0.75, p.size * 2.6, p.size * 1.5, 1.5);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.arc(0, 0, p.size * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

/* ── The money bag ─────────────────────────────────────────────────────── */

/** Classic cartoon loot sack, ~40×38 at s=1, anchored at its belly center.
 *  `textFlip` counter-mirrors the "$" when the carrier context is mirrored. */
function drawMoneyBag(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  textFlip: 1 | -1,
  sway = 0,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(sway);
  ctx.scale(s, s);
  // Floppy neck above the tie
  ctx.fillStyle = "#8a5f2b";
  ctx.beginPath();
  ctx.moveTo(-6, -13);
  ctx.quadraticCurveTo(-2, -21, 1, -20);
  ctx.quadraticCurveTo(6, -19, 6, -13);
  ctx.closePath();
  ctx.fill();
  // Sack belly
  const cloth = ctx.createLinearGradient(0, -14, 0, 20);
  cloth.addColorStop(0, "#c08c46");
  cloth.addColorStop(1, "#7a5220");
  ctx.fillStyle = cloth;
  ctx.beginPath();
  ctx.moveTo(-5, -12);
  ctx.bezierCurveTo(-19, -6, -21, 17, 0, 19);
  ctx.bezierCurveTo(21, 17, 19, -6, 5, -12);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(58,34,8,0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // Rope tie
  ctx.fillStyle = "#5c3a17";
  rr(ctx, -7, -14.5, 14, 4.5, 2);
  ctx.fill();
  // Gloss
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(-2, 2, 12, Math.PI * 1.05, Math.PI * 1.5);
  ctx.stroke();
  // The $ — always upright, whichever way the carrier faces
  ctx.save();
  ctx.scale(textFlip, 1);
  ctx.font = '900 15px "Arial Black", sans-serif';
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(58,34,8,0.65)";
  ctx.lineWidth = 3.5;
  ctx.strokeText("$", 0, 10);
  ctx.fillStyle = "#ffd24a";
  ctx.fillText("$", 0, 10);
  ctx.restore();
  ctx.restore();
}

/* ── The rep (same jersey/cap identity as the welcome intro) ───────────── */

type Pose = "stand" | "run" | "kick" | "walk" | "carry" | "pose";

type RepState = {
  x: number;
  y: number;
  rot: number;
  alpha: number;
  pose: Pose;
  dir: 1 | -1;
};

const PANTS = "#2c3a66";
const SKIN = "#ffc79c";
const SLEEVE = "#00cfe4";
const SHOE = "#10131f";

function shoe(ctx: CanvasRenderingContext2D, x: number, y: number, w = 13) {
  ctx.fillStyle = SHOE;
  rr(ctx, x, y, w, 5, 2.5);
  ctx.fill();
}

/** Feet anchored at local (0,0); design faces right, `dir:-1` mirrors. */
function drawRep(ctx: CanvasRenderingContext2D, s: RepState, t: number) {
  const running = s.pose === "run";
  const walking = s.pose === "walk" || s.pose === "carry";
  const ph = running ? t * 0.021 : t * 0.013; // gait cycle
  const swing = running ? 0.85 : walking ? 0.52 : 0;
  const bob = running ? Math.abs(Math.sin(ph)) * 3.5 : walking ? Math.abs(Math.sin(ph)) * 2.2 : 0;
  const lean = running ? -0.16 : s.pose === "carry" ? -0.05 : 0;

  ctx.save();
  ctx.globalAlpha *= s.alpha;
  ctx.translate(s.x, s.y - bob);
  ctx.rotate(s.rot);
  ctx.scale(s.dir, 1);
  ctx.rotate(lean);

  const hipY = -28;
  const shoulderY = -48;
  const kicking = s.pose === "kick";

  // Loot bag rides behind the shoulder — painted first so the body overlaps.
  if (s.pose === "carry") {
    drawMoneyBag(ctx, -14, shoulderY - 7 + Math.sin(ph) * 1.6, 0.92, s.dir, -0.12);
  } else if (s.pose === "pose") {
    drawMoneyBag(ctx, 4, shoulderY - 42, 1, s.dir, Math.sin(t / 240) * 0.09);
  }

  // Legs
  if (kicking) {
    // Flying side kick: lead leg dead level at the door, trail leg tucked
    ctx.save();
    ctx.translate(2, hipY);
    ctx.rotate(-Math.PI / 2 + 0.06);
    ctx.fillStyle = PANTS;
    rr(ctx, -4.5, 0, 9, 30, 4.5);
    ctx.fill();
    ctx.fillStyle = SHOE;
    rr(ctx, -5.5, 27, 12, 7, 3); // toe punching forward
    ctx.fill();
    ctx.restore();
    limb(ctx, -3, hipY, 0.9, 19, 9, PANTS); // tucked trail leg
    shoe(ctx, -14, hipY + 15, 11);
  } else if (s.pose === "pose") {
    limb(ctx, -4, hipY, 0.16, 28, 9, PANTS);
    limb(ctx, 5, hipY, -0.16, 28, 9, PANTS);
    shoe(ctx, -12, -4);
    shoe(ctx, 3, -4);
  } else if (running || walking) {
    limb(ctx, 0, hipY, Math.sin(ph) * swing + 0.2, 28, 9, PANTS);
    limb(ctx, 1, hipY, -Math.sin(ph) * swing + 0.2, 28, 9, PANTS);
    const fx = Math.sin(ph) * (running ? 13 : 8);
    shoe(ctx, -8 + fx, -4);
    shoe(ctx, -6 - fx, -4);
  } else {
    limb(ctx, -4, hipY, 0.08, 28, 9, PANTS);
    limb(ctx, 5, hipY, -0.05, 28, 9, PANTS);
    shoe(ctx, -9, -4);
    shoe(ctx, 1, -4);
  }

  // Torso — the same neon-cyan jersey the welcome intro wears
  const jersey = ctx.createLinearGradient(0, shoulderY - 6, 0, hipY);
  jersey.addColorStop(0, "#5ff7ff");
  jersey.addColorStop(0.45, "#00e0f2");
  jersey.addColorStop(1, "#00a8c2");
  ctx.fillStyle = jersey;
  rr(ctx, -9, shoulderY - 5, 19, 29, 9);
  ctx.fill();

  // Arms
  if (kicking) {
    limb(ctx, -6, shoulderY, 0.85, 24, 7.5, SLEEVE); // thrown back for balance
    limb(ctx, 7, shoulderY, -1.25, 24, 7.5, SLEEVE); // punched forward-up
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(-24, shoulderY + 14, 4.4, 0, Math.PI * 2);
    ctx.arc(30, shoulderY + 6, 4.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (s.pose === "carry") {
    // Rear arm up over the shoulder gripping the bag neck
    limb(ctx, -2, shoulderY, 2.55, 20, 7.5, SLEEVE);
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(-13, shoulderY - 17, 4.2, 0, Math.PI * 2);
    ctx.fill();
    // Free arm swings with the strut
    limb(ctx, 7, shoulderY, -Math.sin(ph) * 0.5, 24, 7.5, SLEEVE);
  } else if (s.pose === "pose") {
    // One arm hoists the bag overhead, the other pumps
    limb(ctx, 4, shoulderY, Math.PI + Math.sin(t / 240) * 0.06, 26, 7.5, SLEEVE);
    const pump = Math.sin(t / 90) * 0.18;
    limb(ctx, -7, shoulderY, Math.PI * 0.78 + pump, 24, 7.5, SLEEVE);
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(4, shoulderY - 28, 4.4, 0, Math.PI * 2);
    ctx.arc(-24, shoulderY - 16 + pump * 8, 4.4, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const armSwing = running || walking ? Math.sin(ph + Math.PI) * (running ? 0.9 : 0.5) : 0;
    limb(ctx, -6, shoulderY, armSwing, 24, 7.5, SLEEVE);
    limb(ctx, 7, shoulderY, -armSwing, 24, 7.5, SLEEVE);
  }

  // Head + pink cap
  const headY = shoulderY - 15;
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(1, headY, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ff2d92";
  ctx.beginPath();
  ctx.arc(1, headY - 1.5, 10, Math.PI, 0);
  ctx.fill();
  rr(ctx, 3, headY - 5.5, 13, 4, 2); // brim toward facing
  ctx.fill();
  ctx.fillStyle = "#10131f"; // eye
  ctx.beginPath();
  ctx.arc(6.5, headY + 1.5, 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/** Where the rep is at time t — position, pose, facing, and doorway fades. */
function repState(t: number): RepState {
  if (t < T_RUN_START) return { x: RUN_FROM, y: GROUND, rot: 0, alpha: 1, pose: "stand", dir: 1 };
  if (t < T_LEAP) {
    const p = easeInOut(clamp01((t - T_RUN_START) / (T_LEAP - T_RUN_START)));
    return {
      x: RUN_FROM + (RUN_TO - RUN_FROM) * p,
      y: GROUND,
      rot: 0,
      alpha: 1,
      pose: "run",
      dir: 1,
    };
  }
  if (t < T_KICK) {
    const p = clamp01((t - T_LEAP) / (T_KICK - T_LEAP));
    return {
      x: RUN_TO + (LAND_X - RUN_TO) * p,
      y: GROUND - 34 * Math.sin((p * Math.PI) / 2),
      rot: -0.5 * p,
      alpha: 1,
      pose: "kick",
      dir: 1,
    };
  }
  if (t < T_LAND) {
    const q = clamp01((t - T_KICK) / (T_LAND - T_KICK));
    return {
      x: LAND_X,
      y: GROUND - 34 * (1 - q * q),
      rot: -0.5 * (1 - q),
      alpha: 1,
      pose: "kick",
      dir: 1,
    };
  }
  if (t < T_ENTER) return { x: LAND_X, y: GROUND, rot: 0, alpha: 1, pose: "stand", dir: 1 };
  if (t < T_EXIT) {
    // Steps into the busted doorway and dissolves into the dark
    const p = clamp01((t - T_ENTER) / 260);
    return {
      x: LAND_X + (ENTER_X - LAND_X) * p,
      y: GROUND,
      rot: 0,
      alpha: 1 - p,
      pose: "walk",
      dir: 1,
    };
  }
  if (t < T_POSE) {
    const p = easeInOut(clamp01((t - T_EXIT) / (T_POSE - T_EXIT)));
    return {
      x: ENTER_X + (WALK_TO - ENTER_X) * p,
      y: GROUND,
      rot: 0,
      alpha: clamp01((t - T_EXIT) / 220),
      pose: "carry",
      dir: -1,
    };
  }
  return {
    x: WALK_TO,
    y: GROUND - Math.abs(Math.sin((t - T_POSE) / 180)) * 7,
    rot: 0,
    alpha: 1,
    pose: "pose",
    dir: -1,
  };
}

/* ── Supporting cast + set dressing ────────────────────────────────────── */

/** Homeowner waving the rep off from the (doorless) doorway — this was a
 *  sale, not a heist. Same purple-robe neighbor as the welcome intro. */
function drawOwnerWave(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  alpha: number,
  t: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  const robe = ctx.createLinearGradient(0, -46, 0, 0);
  robe.addColorStop(0, "#b06ff7");
  robe.addColorStop(1, "#7c3ac9");
  // Waving arm behind the body, reaching up-left toward the leaving rep
  limb(ctx, -4, -40, 2.35 + Math.sin(t / 130) * 0.3, 19, 6.5, "#9a55e8");
  ctx.fillStyle = SKIN;
  ctx.beginPath();
  ctx.arc(-15, -55 + Math.sin(t / 130) * 3, 3.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = robe;
  rr(ctx, -11, -44, 22, 44, 8);
  ctx.fill();
  ctx.fillStyle = SKIN;
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
  ctx.strokeStyle = "#10131f"; // grin — happiest customer on the block
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(0, -49, 4, 0.35, Math.PI - 0.35);
  ctx.stroke();
  ctx.restore();
}

/** Sunset-lit cloud — warm body, hot underside, catching the low sun. */
function drawCloud(ctx: CanvasRenderingContext2D, x: number, y: number, s: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  const body = ctx.createLinearGradient(0, -24, 0, 12);
  body.addColorStop(0, "#fff6fb");
  body.addColorStop(0.7, "#ffd9e4");
  body.addColorStop(1, "#ffb08a");
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.arc(-18, 0, 13, 0, Math.PI * 2);
  ctx.arc(0, -8, 17, 0, Math.PI * 2);
  ctx.arc(19, 0, 12, 0, Math.PI * 2);
  ctx.fill();
  rr(ctx, -30, -2, 60, 12, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,140,90,0.45)";
  rr(ctx, -26, 7, 52, 4, 2);
  ctx.fill();
  ctx.restore();
}

function drawTinyHouse(
  ctx: CanvasRenderingContext2D,
  x: number,
  base: number,
  wall: string,
  roof: string,
) {
  // Long dusk shadow thrown away from the low sun
  ctx.fillStyle = "rgba(8,40,30,0.22)";
  ctx.beginPath();
  ctx.ellipse(x + 52, base + 2, 34, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = wall;
  rr(ctx, x, base - 26, 44, 26, 2);
  ctx.fill();
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(x - 5, base - 26);
  ctx.lineTo(x + 49, base - 26);
  ctx.lineTo(x + 22, base - 44);
  ctx.closePath();
  ctx.fill();
  // Sun-side rim light on the roof slope
  ctx.strokeStyle = "rgba(255,220,150,0.7)";
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 5, base - 26);
  ctx.lineTo(x + 22, base - 44);
  ctx.stroke();
  // Windows already glowing for the evening
  ctx.save();
  ctx.shadowColor = "#ffb03a";
  ctx.shadowBlur = 9;
  ctx.fillStyle = "#ffd76b";
  rr(ctx, x + 7, base - 19, 9, 9, 1.5);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#5c3a1c";
  rr(ctx, x + 27, base - 16, 9, 16, [3, 3, 0, 0]);
  ctx.fill();
}

/* ── Scene renderer ────────────────────────────────────────────────────── */

function drawScene(ctx: CanvasRenderingContext2D, t: number, particles: Particle[]) {
  /* Golden hour, cranked — deep indigo overhead melting into hot gold.
   * (First cut was flat noon pastels; owner call 2026-09-10: "way more
   * modern" — so: cinematic dusk grade, bloom, flare, rim light, glow.) */
  const SUN_X = 126;
  const SUN_Y = 96;
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, "#221a66");
  sky.addColorStop(0.38, "#8c2f8e");
  sky.addColorStop(0.68, "#ff5e57");
  sky.addColorStop(0.88, "#ff9138");
  sky.addColorStop(1, "#ffd76b");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VW, VH);

  // Rotating sunburst — the early-2000s promo-art special, in evening gold
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, VW, 224);
  ctx.clip();
  ctx.translate(SUN_X, SUN_Y);
  ctx.rotate((t / 9000) * Math.PI);
  ctx.fillStyle = "rgba(255,214,110,0.13)";
  for (let i = 0; i < 12; i++) {
    ctx.rotate(Math.PI / 6);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    // Long enough that the flat tips always land outside the frame
    ctx.lineTo(760, -56);
    ctx.lineTo(760, 56);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // Low sun with a big soft bloom
  const bloom = ctx.createRadialGradient(SUN_X, SUN_Y, 8, SUN_X, SUN_Y, 118);
  bloom.addColorStop(0, "rgba(255,236,170,0.95)");
  bloom.addColorStop(0.35, "rgba(255,190,110,0.45)");
  bloom.addColorStop(1, "rgba(255,170,90,0)");
  ctx.fillStyle = bloom;
  ctx.fillRect(SUN_X - 130, SUN_Y - 130, 260, 260);
  const sun = ctx.createRadialGradient(SUN_X - 6, SUN_Y - 8, 3, SUN_X, SUN_Y, 26);
  sun.addColorStop(0, "#fffbe8");
  sun.addColorStop(0.55, "#ffe27a");
  sun.addColorStop(1, "#ff9e2a");
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(SUN_X, SUN_Y, 26, 0, Math.PI * 2);
  ctx.fill();
  // Anamorphic flare streak + two lens ghosts falling toward frame center
  const streak = ctx.createLinearGradient(SUN_X - 150, SUN_Y, SUN_X + 150, SUN_Y);
  streak.addColorStop(0, "rgba(255,220,150,0)");
  streak.addColorStop(0.5, "rgba(255,236,190,0.55)");
  streak.addColorStop(1, "rgba(255,220,150,0)");
  ctx.fillStyle = streak;
  rr(ctx, SUN_X - 150, SUN_Y - 2.2, 300, 4.4, 2);
  ctx.fill();
  for (const [gp, gr, ga] of [
    [0.4, 11, 0.14],
    [0.75, 5.5, 0.12],
  ] as const) {
    ctx.fillStyle = `rgba(255,224,160,${ga})`;
    ctx.beginPath();
    ctx.arc(SUN_X + (320 - SUN_X) * gp, SUN_Y + (196 - SUN_Y) * gp, gr, 0, Math.PI * 2);
    ctx.fill();
  }

  const drift = -8 * clamp01(t / DURATION);
  drawCloud(ctx, 268 - drift, 62, 1);
  drawCloud(ctx, 460 - drift * 1.6, 42, 0.72);
  drawCloud(ctx, 90 - drift * 0.7, 132, 0.6);

  /* Hills going blue-green in the last light, gold rims along their crowns */
  const hillBack = ctx.createLinearGradient(0, 216, 0, 300);
  hillBack.addColorStop(0, "#3aa85c");
  hillBack.addColorStop(1, "#1c6b3c");
  ctx.fillStyle = hillBack;
  ctx.beginPath();
  ctx.ellipse(150, 300, 320, 84, 0, Math.PI, 0);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,215,120,0.5)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(150, 300, 320, 84, 0, Math.PI + 0.35, Math.PI * 2 - 0.35);
  ctx.stroke();
  const hillFront = ctx.createLinearGradient(0, 232, 0, 306);
  hillFront.addColorStop(0, "#2f9450");
  hillFront.addColorStop(1, "#175a2e");
  ctx.fillStyle = hillFront;
  ctx.beginPath();
  ctx.ellipse(520, 306, 340, 74, 0, Math.PI, 0);
  ctx.fill();

  // Neighborhood in the distance, windows already lit
  drawTinyHouse(ctx, 34, 276, "#f2b8d8", "#d84f6f");
  drawTinyHouse(ctx, 130, 270, "#b8cdf2", "#4a6fd8");
  drawTinyHouse(ctx, 236, 278, "#f2d9a8", "#e8912a");

  // Warm haze settling over the valley floor
  const haze = ctx.createLinearGradient(0, 210, 0, GROUND);
  haze.addColorStop(0, "rgba(255,160,90,0)");
  haze.addColorStop(1, "rgba(255,160,90,0.2)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 210, VW, GROUND - 210);

  /* The lawn, deep evening green with a warm pool where the action is */
  const lawn = ctx.createLinearGradient(0, GROUND, 0, VH);
  lawn.addColorStop(0, "#2e9c44");
  lawn.addColorStop(1, "#124e22");
  ctx.fillStyle = lawn;
  ctx.fillRect(0, GROUND, VW, VH - GROUND);
  ctx.fillStyle = "rgba(255,230,150,0.07)";
  for (let x = -20; x < VW; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, GROUND);
    ctx.lineTo(x + 32, GROUND);
    ctx.lineTo(x + 18, VH);
    ctx.lineTo(x - 14, VH);
    ctx.closePath();
    ctx.fill();
  }
  const pool = ctx.createRadialGradient(548, 318, 8, 548, 318, 130);
  pool.addColorStop(0, "rgba(255,190,100,0.2)");
  pool.addColorStop(1, "rgba(255,190,100,0)");
  ctx.fillStyle = pool;
  ctx.fillRect(410, GROUND, 230, VH - GROUND);

  // Front path from the door step down toward the viewer
  ctx.fillStyle = "rgba(245,222,178,0.9)";
  ctx.beginPath();
  ctx.moveTo(DOOR_L, 307);
  ctx.quadraticCurveTo(468, 324, 400, VH);
  ctx.lineTo(506, VH);
  ctx.quadraticCurveTo(556, 320, DOOR_L + DOOR_W + 4, 307);
  ctx.closePath();
  ctx.fill();

  // Mailbox on the walk-out line, throwing its own long shadow
  ctx.fillStyle = "rgba(8,40,30,0.25)";
  ctx.beginPath();
  ctx.ellipse(424, GROUND + 4, 22, 3.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#6e4626";
  rr(ctx, 406, 266, 5, 36, 2);
  ctx.fill();
  ctx.fillStyle = "#3d7ff2";
  rr(ctx, 396, 254, 26, 14, [7, 7, 3, 3]);
  ctx.fill();
  ctx.fillStyle = "#ff4757";
  rr(ctx, 419, 246, 3.5, 10, 1.5);
  ctx.fill();

  /* The house getting closed */
  const kickP = clamp01((t - T_KICK) / 300); // door blast progress
  const glow = clamp01((t - T_KACHING) / 260); // money-glow from inside
  // Wall + vinyl siding lines, warmed by the last of the light
  const wall = ctx.createLinearGradient(0, 218, 0, GROUND);
  wall.addColorStop(0, "#ffd98e");
  wall.addColorStop(1, "#ff9a46");
  ctx.fillStyle = wall;
  ctx.fillRect(456, 218, VW - 456, GROUND - 218);
  ctx.strokeStyle = "rgba(120,50,10,0.12)";
  ctx.lineWidth = 1.5;
  for (let y = 228; y < GROUND; y += 10) {
    ctx.beginPath();
    ctx.moveTo(456, y);
    ctx.lineTo(VW, y);
    ctx.stroke();
  }
  // Roof + fascia + chimney
  ctx.fillStyle = "#8a3f2a";
  rr(ctx, 598, 148, 18, 34, 2);
  ctx.fill();
  ctx.fillStyle = "#6e2f22";
  rr(ctx, 594, 142, 26, 8, 2);
  ctx.fill();
  const roof = ctx.createLinearGradient(0, 174, 0, 216);
  roof.addColorStop(0, "#ff5a3c");
  roof.addColorStop(1, "#a8201f");
  ctx.fillStyle = roof;
  ctx.beginPath();
  ctx.moveTo(446, 216);
  ctx.lineTo(654, 216);
  ctx.lineTo(626, 176);
  ctx.lineTo(474, 176);
  ctx.closePath();
  ctx.fill();
  // Sun-side rim light along the roof edge
  ctx.strokeStyle = "rgba(255,220,150,0.85)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(446, 216);
  ctx.lineTo(474, 176);
  ctx.lineTo(626, 176);
  ctx.stroke();
  ctx.fillStyle = "#fff0d6";
  rr(ctx, 442, 212, 216, 8, 3);
  ctx.fill();

  // Window catching the sunset + flowerbox
  ctx.fillStyle = "#fff0d6";
  rr(ctx, 474, 240, 50, 42, 4);
  ctx.fill();
  const glass = ctx.createLinearGradient(478, 244, 478, 278);
  glass.addColorStop(0, "#e87ab8");
  glass.addColorStop(0.55, "#ff8a5c");
  glass.addColorStop(1, "#ffc75c");
  ctx.fillStyle = glass;
  rr(ctx, 478, 244, 42, 34, 3);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(486, 246);
  ctx.lineTo(498, 276);
  ctx.stroke();
  ctx.strokeStyle = "#fff0d6";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(499, 244);
  ctx.lineTo(499, 278);
  ctx.moveTo(478, 261);
  ctx.lineTo(520, 261);
  ctx.stroke();
  ctx.fillStyle = "#8a5a2b";
  rr(ctx, 471, 282, 56, 9, 3);
  ctx.fill();
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? "#ff4d7e" : "#ff8a2a";
    ctx.beginPath();
    ctx.arc(478 + i * 11, 281, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Door frame + the dark opening behind the (soon-to-be-airborne) door
  ctx.fillStyle = "#fff0d6";
  rr(ctx, DOOR_L - 6, DOOR_TOP - 6, DOOR_W + 12, GROUND - DOOR_TOP + 6, [8, 8, 0, 0]);
  ctx.fill();
  ctx.fillStyle = "#17090f";
  rr(ctx, DOOR_L, DOOR_TOP, DOOR_W, GROUND - DOOR_TOP, [5, 5, 0, 0]);
  ctx.fill();
  // Porch lamp, already on for the evening
  ctx.save();
  ctx.shadowColor = "#ffb03a";
  ctx.shadowBlur = 13;
  ctx.fillStyle = "#ffe9a8";
  ctx.beginPath();
  ctx.arc(DOOR_L + DOOR_W + 14, 240, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#4a3a20";
  rr(ctx, DOOR_L + DOOR_W + 12.5, 232, 3, 5, 1);
  ctx.fill();
  if (glow > 0) {
    // Money light floods the hall once the register rings
    const spill = ctx.createRadialGradient(DOOR_CX, 266, 4, DOOR_CX, 266, 90);
    spill.addColorStop(0, `rgba(255,224,130,${0.95 * glow})`);
    spill.addColorStop(0.5, `rgba(255,200,90,${0.4 * glow})`);
    spill.addColorStop(1, "rgba(255,200,90,0)");
    ctx.fillStyle = spill;
    ctx.fillRect(DOOR_L - 40, 196, DOOR_W + 110, 150);
    ctx.fillStyle = `rgba(255,214,122,${0.18 * glow})`;
    ctx.beginPath();
    ctx.ellipse(DOOR_CX, GROUND + 14, 62, 12, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  if (t >= T_WAVE) drawOwnerWave(ctx, DOOR_CX, GROUND - 1, clamp01((t - T_WAVE) / 200), t);

  // The door itself — pristine until T_KICK, then blasted into the hallway
  if (kickP < 1) {
    ctx.save();
    ctx.translate(DOOR_CX, 265 + kickP * 3);
    if (kickP > 0) {
      ctx.rotate(-0.6 * kickP);
      ctx.scale(1 - 0.84 * kickP, 1 - 0.84 * kickP);
      ctx.globalAlpha = 1 - kickP * 0.95;
    }
    const doorPaint = ctx.createLinearGradient(0, -35, 0, 35);
    doorPaint.addColorStop(0, "#f4543c");
    doorPaint.addColorStop(1, "#b32014");
    ctx.fillStyle = doorPaint;
    rr(ctx, -20, -35, 40, 70, [4, 4, 0, 0]);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = 2;
    rr(ctx, -14, -28, 28, 24, 3);
    ctx.stroke();
    rr(ctx, -14, 2, 28, 26, 3);
    ctx.stroke();
    ctx.fillStyle = "#ffd24a";
    ctx.beginPath();
    ctx.arc(-14, 1, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Porch step + bushes flanking the entry
  ctx.fillStyle = "#d8c9b2";
  rr(ctx, DOOR_L - 10, GROUND, DOOR_W + 20, 7, 3);
  ctx.fill();
  for (const [bx, br] of [
    [466, 15],
    [608, 17],
    [634, 13],
  ] as const) {
    const bush = ctx.createRadialGradient(bx - 4, GROUND - br - 2, 2, bx, GROUND - br / 2, br + 6);
    bush.addColorStop(0, "#3fae37");
    bush.addColorStop(1, "#12491a");
    ctx.fillStyle = bush;
    ctx.beginPath();
    ctx.arc(bx, GROUND - br / 2, br, Math.PI, 0);
    ctx.fill();
  }

  /* Impact garnish */
  if (t >= T_KICK && t < T_KICK + 320) {
    // Hot blast core lighting up the wall
    const p = (t - T_KICK) / 320;
    const blast = ctx.createRadialGradient(IMPACT_X, IMPACT_Y, 4, IMPACT_X, IMPACT_Y, 95);
    blast.addColorStop(0, `rgba(255,220,140,${0.55 * (1 - p)})`);
    blast.addColorStop(1, "rgba(255,140,60,0)");
    ctx.fillStyle = blast;
    ctx.fillRect(IMPACT_X - 100, IMPACT_Y - 100, 200, 200);
  }
  if (t >= T_KICK && t < T_KICK + 280) {
    // Shock ring
    const p = (t - T_KICK) / 280;
    ctx.save();
    ctx.globalAlpha = 1 - p;
    ctx.shadowColor = "#ffb02a";
    ctx.shadowBlur = 12;
    ctx.strokeStyle = p < 0.4 ? "#ffffff" : "#ffd24a";
    ctx.lineWidth = 6 - 5 * p;
    ctx.beginPath();
    ctx.arc(IMPACT_X, IMPACT_Y, 6 + 68 * easeOutBack(p), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (t >= T_KICK && t < T_KICK + 460) {
    // Starburst
    const age = t - T_KICK;
    const grow = easeOutBack(clamp01(age / 150));
    const fade = age < 260 ? 1 : 1 - clamp01((age - 260) / 200);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.shadowColor = "#ff8a2a";
    ctx.shadowBlur = 20;
    ctx.translate(IMPACT_X, IMPACT_Y - 2);
    ctx.rotate(0.2);
    ctx.scale(grow, grow);
    for (const [pts, rOut, rIn, color] of [
      [12, 36, 13, "#ff8a2a"],
      [12, 27, 10, "#ffd93d"],
      [8, 15, 6, "#ffffff"],
    ] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      for (let k = 0; k < pts * 2; k++) {
        const r = k % 2 === 0 ? rOut : rIn;
        const a = (k * Math.PI) / pts;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /* The rep + a long dusk shadow */
  const rep = repState(t);
  const airborne = GROUND - rep.y;
  ctx.fillStyle = `rgba(8,34,24,${0.38 - Math.min(0.2, airborne / 200)})`;
  ctx.beginPath();
  ctx.ellipse(rep.x + 9, GROUND + 4, 24 - Math.min(9, airborne / 4), 4.2, 0, 0, Math.PI * 2);
  ctx.fill();
  // Speed lines while sprinting or mid-flight
  if (rep.pose === "run" || rep.pose === "kick") {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      ctx.lineWidth = 2.5 - i * 0.4;
      ctx.beginPath();
      ctx.moveTo(rep.x - 34 - i * 15, rep.y - 50 + i * 12);
      ctx.lineTo(rep.x - 66 - i * 21, rep.y - 50 + i * 12);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawRep(ctx, rep, t);

  drawParticles(ctx, particles, t);

  // Golden motes drifting through the evening air
  for (let i = 0; i < 9; i++) {
    const mx = (i * 73 + t * (0.012 + (i % 3) * 0.004)) % VW;
    const my = 120 + ((i * 47) % 150) + Math.sin(t / 900 + i) * 6;
    ctx.fillStyle = `rgba(255,236,190,${0.05 + 0.05 * (1 + Math.sin(t / 700 + i * 2.1))})`;
    ctx.beginPath();
    ctx.arc(mx, my, 1.6 + (i % 3) * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Callouts — gradients live in popText's local space (0,0 = baseline) */
  if (t >= T_FIGHT && t < T_FIGHT + 640) {
    const g = ctx.createLinearGradient(0, -36, 0, 8);
    g.addColorStop(0, "#fff3b0");
    g.addColorStop(1, "#ffb02a");
    popText(ctx, "FIGHT!", 300, 156, T_FIGHT, t, 46, g, "#ff3b1f");
  }
  if (t >= T_KICK && t < T_KICK + 480) {
    const g = ctx.createLinearGradient(0, -32, 0, 6);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(1, "#ff8a2a");
    popText(ctx, "BOOM!", 486, 172, T_KICK, t, 40, g, "#ff3b1f");
  }
  if (t >= T_KACHING && t < T_KACHING + 460) {
    popText(ctx, "KA-CHING!", 484, 170, T_KACHING, t, 26, "#ffe27a", "#ffb02a");
  }
  if (t >= T_CLOSED) {
    const rise = clamp01((t - T_CLOSED) / 1000);
    const g = ctx.createLinearGradient(0, -42, 0, 9);
    g.addColorStop(0, "#fffbe6");
    g.addColorStop(0.55, "#ffd24a");
    g.addColorStop(1, "#e09a00");
    popText(ctx, "CLOSED!", 308, 168 - rise * 40, T_CLOSED, t, 52, g, "#ff3b1f");
    // Flash right on the beat
    const flash = 1 - clamp01((t - T_CLOSED) / 200);
    if (flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.3})`;
      ctx.fillRect(0, 0, VW, VH);
    }
    // Sparkle stars around the payday
    for (let i = 0; i < 5; i++) {
      const sx = WALK_TO - 60 + i * 34;
      const sy = 168 + ((i * 41) % 58);
      const pulse = Math.max(0, Math.sin(t / 110 + i * 1.4));
      if (pulse <= 0.05) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.scale(pulse, pulse);
      ctx.fillStyle = i % 2 ? "#fff8c8" : "#ffe27a";
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
  }
  if (t >= T_KICK && t < T_KICK + 260) {
    // Impact flash
    const flash = 1 - (t - T_KICK) / 260;
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.26})`;
    ctx.fillRect(0, 0, VW, VH);
  }
}

/** Camera: push-in through the sprint, punch + shake on the kick, a second
 *  smaller punch on the CLOSED! beat. */
function applyCamera(ctx: CanvasRenderingContext2D, t: number) {
  let zoom = 1 + 0.025 * clamp01(t / 4200);
  if (t >= T_KICK) {
    const k = easeOutBack(clamp01((t - T_KICK) / 300));
    const settle = clamp01((t - T_KICK - 300) / 600);
    zoom += 0.07 * k * (1 - 0.7 * settle);
  }
  if (t >= T_CLOSED) zoom += 0.05 * easeOutBack(clamp01((t - T_CLOSED) / 380)) * 0.9;
  let sx = 0;
  let sy = 0;
  const dt = t - T_KICK;
  if (dt > 0 && dt < 260) {
    const a = (1 - dt / 260) * 4.5;
    sx += Math.sin(dt * 0.9) * a;
    sy += Math.cos(dt * 1.3) * a * 0.7;
  }
  const dk = t - T_KACHING;
  if (dk > 0 && dk < 180) {
    const a = (1 - dk / 180) * 1.6;
    sx += Math.sin(dk * 1.1) * a;
  }
  ctx.translate(VW / 2 + sx, VH * 0.62 + sy);
  ctx.scale(zoom, zoom);
  ctx.translate(-VW / 2, -VH * 0.62);
}

/* ── Component ─────────────────────────────────────────────────────────── */

export function CloseKombatIntro({
  userId,
  onActiveChange,
}: {
  userId: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const forced = params?.get("ck_anim") === "1";
  const holdParam = forced ? params?.get("ck_hold") : null;
  const hold = holdParam ? Math.min(DURATION - 1, Math.max(0, Number(holdParam) || 0)) : null;

  const [phase, setPhase] = useState<"checking" | "playing" | "done">(() => {
    if (typeof window === "undefined") return "done";
    if (forced) return "playing";
    return readLocal(seenKey(userId)) ? "done" : "checking";
  });
  const [visible, setVisible] = useState(false);
  const [showCaption, setShowCaption] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const particlesRef = useRef<Particle[]>([]);
  const beepRef = useRef<ReturnType<typeof makeBeeper> | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    onActiveChange?.(phase !== "done");
  }, [phase, onActiveChange]);

  const markSeen = useCallback(() => {
    if (forced) return; // previews never burn the real first-open
    writeLocal(seenKey(userId));
    const patch: AnimMeta = { ti_ck_intro: new Date().toISOString() };
    supabase.auth.updateUser({ data: patch }).catch(() => {});
  }, [forced, userId]);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    setPhase("done");
  }, []);

  // Decide whether to play — same protocol as WelcomeAnimation.
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
      if (meta.ti_ck_intro) {
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

  // Playback
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
    let fightDone = false;
    let kickDone = false;
    let kachingDone = false;
    let closedDone = false;
    let lastDrip = 0;
    const particles = particlesRef.current;
    particles.length = 0;

    const step = (now: number) => {
      const t = hold ?? now - start;
      if (hold == null) {
        if (t >= T_FIGHT && !fightDone) {
          fightDone = true;
          beepRef.current?.(392, 70, 0);
          beepRef.current?.(587, 100, 90);
        }
        if (t >= T_KICK && !kickDone) {
          kickDone = true;
          spawnShards(particles, t);
          beepRef.current?.(65, 150, 0, "square");
          beepRef.current?.(48, 190, 50, "square");
        }
        if (t >= T_KACHING && !kachingDone) {
          kachingDone = true;
          spawnCoins(particles, t, DOOR_CX, 266, 14);
          beepRef.current?.(1318, 70, 0, "sine");
          beepRef.current?.(1760, 260, 80, "sine");
        }
        if (t >= T_CLOSED && !closedDone) {
          closedDone = true;
          const rep = repState(t);
          spawnCoins(particles, t, rep.x + 8, GROUND - 82, 22, true);
          for (let i = 0; i < 12; i++) spawnBill(particles, t, rep.x + 8, GROUND - 82, true);
          beepRef.current?.(523, 90, 0);
          beepRef.current?.(659, 90, 90);
          beepRef.current?.(784, 110, 180);
          beepRef.current?.(1046, 170, 270);
          setShowCaption(true);
        }
        // Bills flutter out of the bag on the strut home
        if (t >= T_EXIT + 250 && t < T_POSE && t - lastDrip > 180) {
          lastDrip = t;
          const rep = repState(t);
          spawnBill(particles, t, rep.x + 13, GROUND - 74);
        }
        stepParticles(particles, t);
        if (t >= T_FADE_OUT) setVisible(false);
        if (t >= DURATION) {
          finish();
          return;
        }
      } else if (particles.length === 0) {
        // Frozen-frame previews still deserve their debris mid-flight
        if (hold >= T_KICK) spawnShards(particles, hold - 120);
        if (hold >= T_KACHING) spawnCoins(particles, hold - 160, DOOR_CX, 266, 14);
        if (hold >= T_CLOSED) {
          const rep = repState(hold);
          spawnCoins(particles, hold - 160, rep.x + 8, GROUND - 82, 22, true);
          for (let i = 0; i < 12; i++)
            spawnBill(particles, hold - 160, rep.x + 8, GROUND - 82, true);
          setShowCaption(true);
        }
        for (let i = 0; i < 10; i++) stepParticles(particles, hold);
      }
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.save();
      applyCamera(ctx, t);
      drawScene(ctx, t, particles);
      ctx.restore();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
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
        background: "radial-gradient(ellipse at 50% 40%, #1c0b10 0%, #070408 70%)",
        opacity: visible ? 1 : 0,
        transition: "opacity 300ms ease",
        cursor: "pointer",
      }}
    >
      <div
        className="font-display uppercase tracking-widest text-kombat-gold text-base sm:text-xl mb-4"
        style={{ textShadow: "0 0 14px color-mix(in oklab, var(--kombat-gold) 70%, transparent)" }}
      >
        Close Kombat
      </div>
      <div
        className="relative w-[min(92vw,720px)] overflow-hidden rounded-xl"
        style={{
          aspectRatio: "640 / 360",
          boxShadow:
            "0 0 40px -10px color-mix(in oklab, var(--kombat-gold) 45%, transparent), 0 24px 60px -20px rgba(0,0,0,0.9)",
        }}
      >
        <canvas ref={canvasRef} width={VW} height={VH} className="w-full h-full" />
        {/* Soft vignette — same 2000s cabinet as the welcome intro */}
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
        className="font-display uppercase tracking-widest text-xs sm:text-sm mt-4 text-kombat-gold"
        style={{
          opacity: showCaption ? 1 : 0,
          transition: "opacity 400ms ease",
          textShadow: "0 0 12px color-mix(in oklab, var(--kombat-gold) 70%, transparent)",
        }}
      >
        Flawless close
      </div>
      <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] text-[10px] font-display uppercase tracking-widest text-muted-foreground/70">
        Tap to skip ▸
      </div>
    </div>
  );
}
