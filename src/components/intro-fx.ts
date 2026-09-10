/**
 * Shared primitives for the first-sign-in cutscenes (WelcomeAnimation's van
 * arrival and CloseKombatIntro's door kick): easing, canvas shape helpers,
 * THPS-style pop text, and the best-effort beeper. Pure drawing/math only —
 * each scene keeps its own timeline, characters, and particles.
 */

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

export const easeOutBack = (p: number) => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2);
};

/** roundRect with a plain-rect fallback for ancient WebViews. */
export function rr(
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

/** A capsule limb hanging from (x, y); ang 0 points straight down, negative
 *  swings toward facing-forward (+x). */
export function limb(
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

/** THPS-style score callout: pops in with overshoot, tilted, outlined. */
export function popText(
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

/** Best-effort bleeps — silent unless the AudioContext is already allowed. */
export function makeBeeper() {
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
      /* audio is a garnish — never let it break an intro */
    }
  };
}
