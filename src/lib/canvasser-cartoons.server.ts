// Canvasser cartoon generation (Close Kombat character-select — field crew,
// owner 2026-10-02). The exact mirror of the rep fighter pipeline
// (rep-cartoons.server.ts), with one difference: canvassers have no Monday
// photo, so the SOURCE is a selfie uploaded by the canvasser (self-serve) or an
// admin, kept in the PRIVATE `canvasser-photos` bucket. The Gemini core —
// prompts, model call, style — is shared with the rep module so the whole cast
// reads as one game. Output lands in the PUBLIC `rep-cartoons` bucket under a
// canvasser/ subfolder and the row flips straight to 'approved' (no review gate,
// per the owner: we iterate on the art later).
// Server-only: service role client + the GEMINI_API_KEY secret.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { normalizeName } from "@/lib/utils";
import {
  CARTOON_STYLE,
  callGemini,
  extFor,
  fullPrompt,
  portraitPrompt,
  type CartoonKind,
} from "@/lib/rep-cartoons.server";

const OUTPUT_BUCKET = "rep-cartoons"; // public — shared with reps
const SOURCE_BUCKET = "canvasser-photos"; // private — raw selfies, never team-facing
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

type InlineSource = { data: string; mimeType: string };

// Tiny stable hash (same idiom as rep-photos.server.ts) — the regen signal when
// a canvasser swaps their selfie.
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Decode a `data:<mime>;base64,<...>` upload into bytes + content type. */
function decodeDataUrl(dataUrl: string): { bytes: Buffer; contentType: string } {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!m) throw new Error("Not a base64 image data URL");
  const contentType = m[1].split(";")[0] || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error("Upload must be an image");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length === 0) throw new Error("Empty image");
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error("Image too large (max 8MB)");
  return { bytes, contentType };
}

async function downloadSource(path: string): Promise<InlineSource> {
  const { data, error } = await supabaseAdmin.storage.from(SOURCE_BUCKET).download(path);
  if (error || !data) throw new Error(`source selfie fetch failed: ${error?.message ?? "missing"}`);
  const buf = Buffer.from(await data.arrayBuffer());
  return { data: buf.toString("base64"), mimeType: data.type || "image/jpeg" };
}

async function uploadCartoon(
  profileId: string,
  kind: CartoonKind,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  // Timestamped so a re-roll never serves a stale cached image.
  const path = `canvasser/${profileId}/${kind}-${Date.now()}.${extFor(contentType)}`;
  const { error } = await supabaseAdmin.storage
    .from(OUTPUT_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = supabaseAdmin.storage.from(OUTPUT_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

async function markFailed(profileId: string, error: string): Promise<void> {
  await supabaseAdmin
    .from("canvasser_photos")
    .update({
      cartoon_status: "failed",
      cartoon_meta: { error, failed_at: new Date().toISOString() } as never,
      updated_at: new Date().toISOString(),
    })
    .eq("profile_id", profileId);
}

export type CanvasserCartoonResult = {
  profile_id: string;
  name: string;
  ok: boolean;
  error?: string;
};

/**
 * Generate (or re-roll) one canvasser's portrait + full-body fighter and go
 * live immediately. `source` lets the uploader hand us the bytes it just saved
 * (no round-trip re-download); otherwise we pull the stored selfie.
 */
export async function generateCanvasserCartoon(
  profileId: string,
  opts?: { styleOverride?: string; source?: InlineSource },
): Promise<CanvasserCartoonResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("canvasser_photos")
    .select("profile_id, name, photo_path, cartoon_prompt")
    .eq("profile_id", profileId)
    .maybeSingle();
  if (rowErr) throw new Error(rowErr.message);
  if (!row) throw new Error(`canvasser_photos row ${profileId} not found`);
  const name = row.name;
  if (!apiKey) {
    const msg = "GEMINI_API_KEY is not set";
    await markFailed(profileId, msg);
    return { profile_id: profileId, name, ok: false, error: msg };
  }
  if (!row.photo_path && !opts?.source) {
    const msg = "no source photo";
    await markFailed(profileId, msg);
    return { profile_id: profileId, name, ok: false, error: msg };
  }

  const style = opts?.styleOverride?.trim() || row.cartoon_prompt?.trim() || CARTOON_STYLE;

  await supabaseAdmin
    .from("canvasser_photos")
    .update({ cartoon_status: "generating", updated_at: new Date().toISOString() })
    .eq("profile_id", profileId);

  try {
    const source = opts?.source ?? (await downloadSource(row.photo_path!));
    // Sequential (not parallel) to stay gentle on the per-key rate limit.
    const portrait = await callGemini(apiKey, portraitPrompt(style), source);
    const full = await callGemini(apiKey, fullPrompt(style), source);
    const portraitUrl = await uploadCartoon(
      profileId,
      "portrait",
      portrait.bytes,
      portrait.contentType,
    );
    const fullUrl = await uploadCartoon(profileId, "full", full.bytes, full.contentType);

    const { error: upErr } = await supabaseAdmin
      .from("canvasser_photos")
      .update({
        cartoon_portrait_url: portraitUrl,
        cartoon_full_url: fullUrl,
        cartoon_prompt: style,
        // No review gate for canvassers — straight to the board.
        cartoon_status: "approved",
        cartoon_meta: {
          model: "gemini-2.5-flash-image",
          generated_at: new Date().toISOString(),
        } as never,
        updated_at: new Date().toISOString(),
      })
      .eq("profile_id", profileId);
    if (upErr) throw new Error(upErr.message);
    return { profile_id: profileId, name, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(profileId, msg);
    return { profile_id: profileId, name, ok: false, error: msg };
  }
}

/**
 * Save a freshly uploaded selfie for a profile, then generate its fighter right
 * away using the bytes in hand. Used by both the self-serve and admin upload
 * server fns — they decide WHOSE profile this is before calling.
 */
export async function saveCanvasserPhotoAndGenerate(
  profileId: string,
  dataUrl: string,
): Promise<CanvasserCartoonResult> {
  const { data: prof, error: pErr } = await supabaseAdmin
    .from("profiles")
    .select("display_name")
    .eq("id", profileId)
    .maybeSingle();
  if (pErr) throw new Error(pErr.message);
  if (!prof) throw new Error("Profile not found");
  const name = prof.display_name ?? "Player";

  const { bytes, contentType } = decodeDataUrl(dataUrl);
  const path = `${profileId}.${extFor(contentType)}`;
  const { error: upErr } = await supabaseAdmin.storage
    .from(SOURCE_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (upErr) throw new Error(`selfie upload failed: ${upErr.message}`);

  // Identity + source only — cartoon_* columns are intentionally absent so an
  // UPDATE on conflict leaves any existing art alone until the regen below
  // overwrites it (mirrors rep-photos.server.ts).
  const { error: rowErr } = await supabaseAdmin.from("canvasser_photos").upsert(
    {
      profile_id: profileId,
      name,
      name_norm: normalizeName(name),
      photo_path: path,
      source_hash: hashString(`${path}:${bytes.length}`),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id" },
  );
  if (rowErr) throw new Error(rowErr.message);

  return await generateCanvasserCartoon(profileId, {
    source: { data: bytes.toString("base64"), mimeType: contentType },
  });
}
