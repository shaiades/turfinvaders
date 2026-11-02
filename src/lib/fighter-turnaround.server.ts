// Fighter turnaround frames (owner 2026-11-02): "just the body spins … you
// would see my side, my back, my other side and my front — all great video
// games have this feature." A flat cartoon can't show a back, so for each
// approved full-body fighter we have Gemini redraw the SAME character at 45°
// steps — 8 views: front (the existing art), then 7 generated rotations.
// The stats-page turntable (SpinningFighter) steps through them like a real
// character-select. Frames live in cartoon_meta.turn_urls on the SAME row as
// the art (no new columns — migrations here need a manual owner apply), and
// turn_source records which full-body url the frames came from, so a re-roll
// of the base art automatically orphans them (generate fns replace
// cartoon_meta wholesale, and the client checks turn_source anyway).
// Server-only: service role client + the GEMINI_API_KEY secret.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { callGemini, extFor, fetchImageInline } from "@/lib/rep-cartoons.server";

const OUTPUT_BUCKET = "rep-cartoons"; // public — both casts' art lives here

// Clockwise from the viewer's left, 45° per step; frame 0 is the existing
// front view, so these are frames 1..7.
const TURN_VIEWS = [
  "a three-quarter view, body turned 45 degrees so they face slightly to the viewer's left",
  "an exact left-side profile view, body turned 90 degrees, facing the viewer's left",
  "a three-quarter rear view, body turned 135 degrees, back mostly toward the viewer",
  "directly from behind — a full back view, 180 degrees, the back of the head and outfit",
  "a three-quarter rear view from the other side, body turned 225 degrees",
  "an exact right-side profile view, body turned 270 degrees, facing the viewer's right",
  "a three-quarter view, body turned 315 degrees so they face slightly to the viewer's right",
] as const;

/** 8 frames = front + the 7 generated views. */
export const TURN_FRAME_COUNT = TURN_VIEWS.length + 1;

function turnPrompt(view: string): string {
  return (
    "Use the provided character image as the exact reference. Redraw the IDENTICAL character — " +
    "same face, same hairstyle, same skin tone, same outfit and colors, same art style, same " +
    "proportions — standing in the same spot on the IDENTICAL completely solid flat background " +
    "color filled edge to edge (no gradient, no pattern, no scenery), but rotated in place and " +
    `seen from ${view}. Same neutral standing pose, arms relaxed. Full body head to feet at the ` +
    "same scale and framing as the reference, feet at the same height, vertical composition. " +
    "No text, no logos, no watermark."
  );
}

export type TurnMeta = {
  turn_urls?: string[];
  turn_source?: string;
  turn_generated_at?: string;
};

type CastRow = {
  key: string; // storage folder + log id
  name: string;
  full_url: string;
  meta: Record<string, unknown>;
};

export type TurnaroundResult = { key: string; name: string; ok: boolean; error?: string };

async function uploadFrame(
  folder: string,
  index: number,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  // Timestamped so a regenerate never serves a stale cached frame.
  const path = `${folder}/turn-${index}-${Date.now()}.${extFor(contentType)}`;
  const { error } = await supabaseAdmin.storage
    .from(OUTPUT_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = supabaseAdmin.storage.from(OUTPUT_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

/** Frames are current when they exist and came from the live full-body art. */
export function turnIsCurrent(meta: unknown, fullUrl: string | null): boolean {
  const m = (meta ?? {}) as TurnMeta;
  return (
    !!fullUrl &&
    Array.isArray(m.turn_urls) &&
    m.turn_urls.length === TURN_FRAME_COUNT &&
    m.turn_source === fullUrl
  );
}

async function generateFrames(row: CastRow): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const source = await fetchImageInline(row.full_url);
  const urls: string[] = [row.full_url]; // frame 0 — the existing front view
  // Sequential (not parallel) to stay gentle on the per-key rate limit,
  // matching the portrait/full generators.
  for (let i = 0; i < TURN_VIEWS.length; i++) {
    const frame = await callGemini(apiKey, turnPrompt(TURN_VIEWS[i]), source);
    urls.push(await uploadFrame(row.key, i + 1, frame.bytes, frame.contentType));
  }
  return urls;
}

function mergedMeta(row: CastRow, urls: string[]): Record<string, unknown> {
  return {
    ...row.meta,
    turn_urls: urls,
    turn_source: row.full_url,
    turn_generated_at: new Date().toISOString(),
  };
}

/** Generate the 7 missing views for one REP (Monday cast). */
export async function generateRepTurnaround(mondayUserId: number): Promise<TurnaroundResult> {
  const { data: r, error } = await supabaseAdmin
    .from("rep_photos")
    .select("monday_user_id, name, cartoon_full_url, cartoon_status, cartoon_meta")
    .eq("monday_user_id", mondayUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const key = String(mondayUserId);
  if (!r || r.cartoon_status !== "approved" || !r.cartoon_full_url) {
    return { key, name: r?.name ?? key, ok: false, error: "no approved full-body art" };
  }
  const row: CastRow = {
    key,
    name: r.name,
    full_url: r.cartoon_full_url,
    meta: (r.cartoon_meta ?? {}) as Record<string, unknown>,
  };
  try {
    const urls = await generateFrames(row);
    const { error: upErr } = await supabaseAdmin
      .from("rep_photos")
      .update({ cartoon_meta: mergedMeta(row, urls) as never, updated_at: new Date().toISOString() })
      .eq("monday_user_id", mondayUserId);
    if (upErr) throw new Error(upErr.message);
    return { key, name: row.name, ok: true };
  } catch (err) {
    return { key, name: row.name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Generate the 7 missing views for one CANVASSER/confirmer (selfie cast). */
export async function generateCanvasserTurnaround(profileId: string): Promise<TurnaroundResult> {
  const { data: r, error } = await supabaseAdmin
    .from("canvasser_photos")
    .select("profile_id, name, cartoon_full_url, cartoon_status, cartoon_meta")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const key = `canvasser/${profileId}`;
  if (!r || r.cartoon_status !== "approved" || !r.cartoon_full_url) {
    return { key, name: r?.name ?? profileId, ok: false, error: "no approved full-body art" };
  }
  const row: CastRow = {
    key,
    name: r.name,
    full_url: r.cartoon_full_url,
    meta: (r.cartoon_meta ?? {}) as Record<string, unknown>,
  };
  try {
    const urls = await generateFrames(row);
    const { error: upErr } = await supabaseAdmin
      .from("canvasser_photos")
      .update({ cartoon_meta: mergedMeta(row, urls) as never, updated_at: new Date().toISOString() })
      .eq("profile_id", profileId);
    if (upErr) throw new Error(upErr.message);
    return { key, name: row.name, ok: true };
  } catch (err) {
    return { key, name: row.name, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Draw spin frames for every approved fighter (both casts) that has none yet
 * or whose frames came from since-re-rolled art. Bounded per call — each
 * fighter is 7 Gemini image generations — and idempotent; the admin button
 * loops until `remaining` hits 0, exactly like the re-roll button.
 */
export async function generateMissingTurnarounds(opts?: {
  limit?: number;
}): Promise<{ attempted: number; ok: number; failed: number; remaining: number; results: TurnaroundResult[] }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 1, 3));

  const [repRes, canvRes] = await Promise.all([
    supabaseAdmin
      .from("rep_photos")
      .select("monday_user_id, cartoon_full_url, cartoon_meta")
      .eq("cartoon_status", "approved")
      .not("cartoon_full_url", "is", null),
    supabaseAdmin
      .from("canvasser_photos")
      .select("profile_id, cartoon_full_url, cartoon_meta")
      .eq("cartoon_status", "approved")
      .not("cartoon_full_url", "is", null),
  ]);
  if (repRes.error) throw new Error(repRes.error.message);
  if (canvRes.error) throw new Error(canvRes.error.message);

  const queue: Array<{ cast: "rep"; id: number } | { cast: "canvasser"; id: string }> = [];
  for (const r of repRes.data ?? []) {
    if (!turnIsCurrent(r.cartoon_meta, r.cartoon_full_url)) {
      queue.push({ cast: "rep", id: Number(r.monday_user_id) });
    }
  }
  for (const c of canvRes.data ?? []) {
    if (!turnIsCurrent(c.cartoon_meta, c.cartoon_full_url)) {
      queue.push({ cast: "canvasser", id: c.profile_id });
    }
  }

  const batch = queue.slice(0, limit);
  const results: TurnaroundResult[] = [];
  for (const item of batch) {
    results.push(
      item.cast === "rep"
        ? await generateRepTurnaround(item.id)
        : await generateCanvasserTurnaround(item.id),
    );
  }
  return {
    attempted: batch.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    remaining: Math.max(0, queue.length - batch.length),
    results,
  };
}
