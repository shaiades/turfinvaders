// A clean 9:16 share card for the Daily Wrap — avatar initials, rank, sits,
// sit rate, sales and bonus progress. Drawn to an offscreen canvas with NO
// external deps and NO customer PII (no lead names or addresses). The avatar is
// drawn as an initials disc rather than the fighter photo so the canvas is
// never cross-origin-tainted and export always succeeds. Client-only.

export type ShareCardData = {
  name: string;
  scopeLabel: string; // "TODAY" | "THIS WEEK" | "THIS MONTH"
  dateLabel: string; // "Oct 5, 2026"
  rank: number | null;
  sits: number;
  sitRateLabel: string; // "S · 55%" or "—"
  salesLabel: string; // "$42K"
  bonusLabel: string; // "Boss 3 · 2 chests"
};

const W = 1080;
const H = 1920;
const INK = "#0b0b12";
const PINK = "#ff3d9a";
const GOLD = "#ffcf33";
const CYAN = "#22e6ff";
const GREEN = "#3be089";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Render the share card to a PNG Blob (9:16, 1080×1920). */
export async function renderShareCard(d: ShareCardData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");

  // Background: deep ink with a neon radial wash.
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, H * 0.32, 60, W / 2, H * 0.32, W * 0.9);
  glow.addColorStop(0, "rgba(255,61,154,0.22)");
  glow.addColorStop(1, "rgba(11,11,18,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Neon frame.
  ctx.strokeStyle = PINK;
  ctx.lineWidth = 6;
  ctx.shadowColor = PINK;
  ctx.shadowBlur = 40;
  roundRect(ctx, 40, 40, W - 80, H - 80, 48);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const center = W / 2;
  ctx.textAlign = "center";

  // Wordmark.
  ctx.fillStyle = CYAN;
  ctx.font = "700 46px 'JetBrains Mono', monospace";
  ctx.fillText("TURF INVADERS", center, 170);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "600 30px 'JetBrains Mono', monospace";
  ctx.fillText(`${d.scopeLabel} · ${d.dateLabel}`, center, 220);

  // Avatar disc with initials.
  const cy = 430;
  ctx.beginPath();
  ctx.arc(center, cy, 150, 0, Math.PI * 2);
  ctx.fillStyle = PINK;
  ctx.shadowColor = PINK;
  ctx.shadowBlur = 50;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = INK;
  ctx.font = "700 130px 'JetBrains Mono', monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(initials(d.name), center, cy + 6);
  ctx.textBaseline = "alphabetic";

  // Name + rank.
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 72px 'JetBrains Mono', monospace";
  ctx.fillText(d.name.toUpperCase(), center, cy + 270);
  if (d.rank != null) {
    ctx.fillStyle = GOLD;
    ctx.font = "700 60px 'JetBrains Mono', monospace";
    ctx.fillText(`RANK #${d.rank}`, center, cy + 350);
  }

  // Stat tiles.
  const tiles: Array<[string, string, string]> = [
    ["SITS", String(d.sits), GREEN],
    ["SIT RATE", d.sitRateLabel, CYAN],
    ["SALES", d.salesLabel, GOLD],
    ["BONUS", d.bonusLabel, PINK],
  ];
  const tileW = W - 200;
  const tileH = 150;
  let ty = 1080;
  for (const [label, value, color] of tiles) {
    roundRect(ctx, 100, ty, tileW, tileH, 28);
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = "600 34px 'JetBrains Mono', monospace";
    ctx.fillText(label, 150, ty + 95);
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.font = "700 66px 'JetBrains Mono', monospace";
    ctx.fillText(value, W - 150, ty + 100);
    ty += tileH + 30;
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "600 28px 'JetBrains Mono', monospace";
  ctx.fillText("turfinvaders.com", center, H - 90);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/**
 * Share the card via the Web Share API when files are supported (phones),
 * otherwise fall back to a download. User-initiated only.
 */
export async function shareOrDownloadCard(blob: Blob, filename: string): Promise<void> {
  const file = new File([blob], filename, { type: "image/png" });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    if (nav.canShare?.({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: "My Turf Invaders day" });
      return;
    }
  } catch {
    // user cancelled or share failed — fall through to download
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
