// Rep cartoon generation (Close Kombat character-select, owner 2026-10-02).
// Turns a rep's real Monday photo into a Street Fighter-style cartoon fighter
// with Gemini 2.5 Flash Image ("Nano Banana"): a head-and-shoulders PORTRAIT for
// the roster + a FULL-BODY fighter for the hero / VS / champion. Output lands in
// the public `rep-cartoons` bucket and the row flips to 'pending_review' — only
// an admin Approve makes it team-visible.
// Server-only: service role client + the GEMINI_API_KEY secret.

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GEMINI_MODEL = "gemini-2.5-flash-image";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// One shared art direction so the whole roster reads as a single game's cast.
// Stored on the row (cartoon_prompt) so admins can tweak + re-roll per rep.
export const CARTOON_STYLE =
  "Bold arcade fighting-game character in the style of a Street Fighter character-select screen. " +
  "Keep the person clearly recognizable — same facial features, face shape, hairstyle, skin tone, " +
  "facial hair, and glasses if they have them. Thick clean ink outlines, cel-shaded comic coloring, " +
  "vivid saturated palette, dramatic rim lighting. Heroic, flattering and respectful — never a mocking " +
  "or ugly caricature. No text, no logos, no watermark.";

const PORTRAIT_FRAMING =
  "Head-and-shoulders portrait, confident three-quarter hero pose, subtle red-and-gold halftone " +
  "background, square composition.";
const FULL_BODY_FRAMING =
  "Full body head to feet, dynamic ready-to-fight stance, athletic hero proportions, generic modern " +
  "fighter outfit, plain simple studio background, vertical composition.";

export type CartoonKind = "portrait" | "full";

function portraitPrompt(style: string): string {
  return `${style} ${PORTRAIT_FRAMING}`;
}
function fullPrompt(style: string): string {
  return `${style} ${FULL_BODY_FRAMING}`;
}

/** Fetch an image URL server-side → base64 + mime (Monday photo URLs are public). */
async function fetchImageInline(url: string): Promise<{ data: string; mimeType: string }> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`source photo fetch failed: HTTP ${resp.status}`);
  const mimeType = resp.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buf = Buffer.from(await resp.arrayBuffer());
  return { data: buf.toString("base64"), mimeType };
}

type GeminiPart = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  inline_data?: { mime_type?: string; data?: string };
};

/** One Gemini image generation: text prompt + the source face → PNG bytes. */
async function callGemini(
  apiKey: string,
  prompt: string,
  source: { data: string; mimeType: string },
): Promise<{ bytes: Buffer; contentType: string }> {
  const resp = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: source.mimeType, data: source.data } },
          ],
        },
      ],
      generationConfig: { responseModalities: ["IMAGE"] },
    }),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}: ${bodyText.slice(0, 300)}`);
  let json: { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error(`Gemini: non-JSON response: ${bodyText.slice(0, 200)}`);
  }
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = p.inlineData ?? p.inline_data;
    const data = (inline as { data?: string })?.data;
    if (data) {
      const contentType =
        (p.inlineData?.mimeType ?? p.inline_data?.mime_type ?? "image/png") || "image/png";
      return { bytes: Buffer.from(data, "base64"), contentType };
    }
  }
  // No image part — usually a safety refusal; surface any text the model returned.
  const text = parts.find((p) => p.text)?.text;
  throw new Error(`Gemini returned no image${text ? `: ${text.slice(0, 200)}` : ""}`);
}

function extFor(contentType: string): string {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("webp")) return "webp";
  return "png";
}

async function uploadCartoon(
  mondayUserId: number,
  kind: CartoonKind,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  // Timestamped path so a re-roll never serves a stale cached image.
  const path = `${mondayUserId}/${kind}-${Date.now()}.${extFor(contentType)}`;
  const { error } = await supabaseAdmin.storage
    .from("rep-cartoons")
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
  const { data } = supabaseAdmin.storage.from("rep-cartoons").getPublicUrl(path);
  return data.publicUrl;
}

export type CartoonGenResult = {
  monday_user_id: number;
  name: string;
  ok: boolean;
  error?: string;
};

/** Generate (or re-roll) one rep's portrait + full-body fighter. */
export async function generateRepCartoon(
  mondayUserId: number,
  opts?: { styleOverride?: string },
): Promise<CartoonGenResult> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("rep_photos")
    .select("monday_user_id, name, photo_url, cartoon_prompt")
    .eq("monday_user_id", mondayUserId)
    .maybeSingle();
  if (rowErr) throw new Error(rowErr.message);
  if (!row) throw new Error(`rep_photos row ${mondayUserId} not found`);
  const name = row.name;
  if (!apiKey) {
    const msg = "GEMINI_API_KEY is not set";
    await markFailed(mondayUserId, msg);
    return { monday_user_id: mondayUserId, name, ok: false, error: msg };
  }
  if (!row.photo_url) {
    const msg = "no source photo";
    await markFailed(mondayUserId, msg);
    return { monday_user_id: mondayUserId, name, ok: false, error: msg };
  }

  const style = opts?.styleOverride?.trim() || row.cartoon_prompt?.trim() || CARTOON_STYLE;

  await supabaseAdmin
    .from("rep_photos")
    .update({ cartoon_status: "generating", updated_at: new Date().toISOString() })
    .eq("monday_user_id", mondayUserId);

  try {
    const source = await fetchImageInline(row.photo_url);
    // Sequential (not parallel) to stay gentle on the per-key rate limit.
    const portrait = await callGemini(apiKey, portraitPrompt(style), source);
    const full = await callGemini(apiKey, fullPrompt(style), source);
    const portraitUrl = await uploadCartoon(
      mondayUserId,
      "portrait",
      portrait.bytes,
      portrait.contentType,
    );
    const fullUrl = await uploadCartoon(mondayUserId, "full", full.bytes, full.contentType);

    const { error: upErr } = await supabaseAdmin
      .from("rep_photos")
      .update({
        cartoon_portrait_url: portraitUrl,
        cartoon_full_url: fullUrl,
        cartoon_prompt: style,
        cartoon_status: "pending_review",
        cartoon_meta: { model: GEMINI_MODEL, generated_at: new Date().toISOString() } as never,
        updated_at: new Date().toISOString(),
      })
      .eq("monday_user_id", mondayUserId);
    if (upErr) throw new Error(upErr.message);
    return { monday_user_id: mondayUserId, name, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(mondayUserId, msg);
    return { monday_user_id: mondayUserId, name, ok: false, error: msg };
  }
}

async function markFailed(mondayUserId: number, error: string): Promise<void> {
  await supabaseAdmin
    .from("rep_photos")
    .update({
      cartoon_status: "failed",
      cartoon_meta: { error, failed_at: new Date().toISOString() } as never,
      updated_at: new Date().toISOString(),
    })
    .eq("monday_user_id", mondayUserId);
}

/**
 * Batch generate for reps that have no cartoon yet (status 'none' or 'failed').
 * Bounded (default 6) to stay inside the serverless time budget — the admin
 * button + cron drain the queue across calls. Optionally target explicit ids.
 */
export async function generateRepCartoons(opts?: {
  limit?: number;
  mondayUserIds?: number[];
}): Promise<{ attempted: number; ok: number; failed: number; results: CartoonGenResult[] }> {
  const limit = Math.max(1, Math.min(opts?.limit ?? 6, 20));
  let ids = opts?.mondayUserIds ?? [];
  if (ids.length === 0) {
    const { data, error } = await supabaseAdmin
      .from("rep_photos")
      .select("monday_user_id")
      .in("cartoon_status", ["none", "failed"])
      .not("photo_url", "is", null)
      .order("updated_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(error.message);
    ids = (data ?? []).map((r) => Number(r.monday_user_id));
  } else {
    ids = ids.slice(0, limit);
  }

  const results: CartoonGenResult[] = [];
  for (const id of ids) {
    results.push(await generateRepCartoon(id));
  }
  return {
    attempted: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}
