// Cuts the fighter's BODY out of its flat backdrop so the stats-page
// turntable spins a silhouette, not a rectangle (owner 2026-11-02: "I don't
// want their card to spin, I want their body to spin like a videogame").
// The cartoon pipeline paints a completely solid single-color background
// (van color / charcoal — canvasser-cartoons.server.ts), so a chroma-key
// flood fill from the image borders is reliable: it erases only background
// CONNECTED to the edge, never a shirt that happens to match the van color.
// Everything runs client-side on a canvas; a tainted canvas (no CORS) or any
// failure resolves null and the caller keeps the uncut art.

const cache = new Map<string, Promise<string | null>>();

/** Resolve a transparent-background object URL for the fighter art, or null
 *  when the cutout can't be made (CORS taint, decode failure, no clear
 *  background). Cached per source URL for the session. */
export function fighterCutout(url: string): Promise<string | null> {
  let p = cache.get(url);
  if (!p) {
    p = makeCutout(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

async function makeCutout(url: string): Promise<string | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.decoding = "async";
  img.src = url;
  await img.decode();

  // Cap work on huge art — the turntable renders ~100px tall anyway.
  const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);

  // getImageData throws on a tainted canvas → caught by the caller → null.
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  // The backdrop color = the average of the four corners (they're all the
  // same flat fill on pipeline art; averaging shrugs off jpeg noise).
  const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
  let br = 0;
  let bg = 0;
  let bb = 0;
  for (const o of corners) {
    br += px[o];
    bg += px[o + 1];
    bb += px[o + 2];
  }
  br /= 4;
  bg /= 4;
  bb /= 4;
  // Corners that disagree wildly mean there IS no flat backdrop (user-shot
  // photo, scenery) — keep the art whole rather than eating the figure.
  for (const o of corners) {
    if (dist2(px[o], px[o + 1], px[o + 2], br, bg, bb) > 48 * 48) return null;
  }

  // BFS flood fill from every border pixel: tolerance generous enough for
  // jpeg mottling, but only edge-connected pixels ever clear.
  const TOL2 = 42 * 42;
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const push = (i: number) => {
    if (!visited[i] && dist2(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], br, bg, bb) <= TOL2) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + (w - 1));
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  // A real cutout clears a meaningful share of the frame; almost nothing
  // cleared means the key failed — keep the art whole.
  if (tail < w * h * 0.08) return null;

  for (let k = 0; k < tail; k++) px[queue[k] * 4 + 3] = 0;
  // Feather: an opaque pixel touching cleared background gets alpha scaled
  // by how close its color sits to the backdrop — kills the hard halo.
  const cleared = visited;
  for (let i = 0; i < w * h; i++) {
    if (cleared[i]) continue;
    const x = i % w;
    const edge =
      (x > 0 && cleared[i - 1]) ||
      (x < w - 1 && cleared[i + 1]) ||
      (i >= w && cleared[i - w]) ||
      (i < w * (h - 1) && cleared[i + w]);
    if (!edge) continue;
    const d = Math.sqrt(dist2(px[i * 4], px[i * 4 + 1], px[i * 4 + 2], br, bg, bb));
    px[i * 4 + 3] = Math.min(255, Math.round(Math.min(1, d / 84) * 255));
  }

  ctx.putImageData(data, 0, 0);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}

function dist2(r: number, g: number, b: number, r2: number, g2: number, b2: number): number {
  const dr = r - r2;
  const dg = g - g2;
  const db = b - b2;
  return dr * dr + dg * dg + db * db;
}
