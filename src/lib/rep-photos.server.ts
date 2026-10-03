// Rep photo sync (Close Kombat character-select, owner 2026-10-02). Pulls every
// Monday user's profile photo into public.rep_photos — the PRIVATE source the
// Gemini cartoon pipeline (rep-cartoons.server.ts) later stylizes. A SIBLING
// engine on purpose (collections/production doctrine): a photo hiccup must never
// surface as a Close Kombat sync failure.
// Server-only: touches the service role client and the Monday token.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { monday } from "@/lib/monday.server";
import { laTodayISO } from "@/lib/dates";
import { normalizeName } from "@/lib/utils";

export type RepPhotoSyncSummary = {
  fetched: number;
  upserted: number;
  reset_for_regen: number;
};

type MondayUser = {
  id: string;
  name: string | null;
  title: string | null;
  photo_url: { small: string | null } | null;
};

// Tiny stable hash of the source photo URL (it carries a ?<timestamp> that
// moves only when the rep changes their Monday photo) — the regen signal.
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export async function syncRepPhotos(): Promise<RepPhotoSyncSummary> {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("monday_api_token")
    .maybeSingle();
  const token = (settings?.monday_api_token as string | null) ?? "";
  if (!token) throw new Error("No monday_api_token in system_settings.");

  const res = await monday(
    token,
    `query { users(limit: 500, kind: all) { id name title photo_url { small } } }`,
  );
  const users = ((res?.users as MondayUser[] | undefined) ?? []).filter(
    (u): u is MondayUser & { name: string; photo_url: { small: string } } =>
      !!u && !!u.name && !!u.photo_url?.small,
  );

  // Only reset a cartoon back to 'none' when the SOURCE photo actually changed —
  // approved art must survive a routine re-sync.
  const { data: existing } = await supabaseAdmin
    .from("rep_photos")
    .select("monday_user_id, source_hash, cartoon_status");
  const prev = new Map<number, { source_hash: string | null; cartoon_status: string }>();
  for (const r of existing ?? []) {
    prev.set(Number(r.monday_user_id), {
      source_hash: r.source_hash,
      cartoon_status: r.cartoon_status,
    });
  }

  const nowISO = new Date().toISOString();
  const base = users.map((u) => {
    const photo = u.photo_url.small;
    return {
      monday_user_id: Number(u.id),
      name: u.name,
      name_norm: normalizeName(u.name),
      title: u.title ?? null,
      photo_url: photo,
      source_hash: hashString(photo),
      updated_at: nowISO,
    };
  });

  // Base upsert: identity + source photo. cartoon_* columns are intentionally
  // absent so an UPDATE on conflict leaves existing art untouched (and an INSERT
  // takes the DB defaults: status 'none', urls null).
  if (base.length > 0) {
    const { error } = await supabaseAdmin
      .from("rep_photos")
      .upsert(base, { onConflict: "monday_user_id" });
    if (error) throw new Error(error.message);
  }

  // Second pass: reps whose source photo moved AND already had art → queue a
  // regeneration (clear the stale cartoon so the generator picks it up).
  const regenIds = base
    .filter((r) => {
      const was = prev.get(r.monday_user_id);
      return !!was && was.cartoon_status !== "none" && was.source_hash !== r.source_hash;
    })
    .map((r) => r.monday_user_id);
  if (regenIds.length > 0) {
    await supabaseAdmin
      .from("rep_photos")
      .update({ cartoon_status: "none", cartoon_portrait_url: null, cartoon_full_url: null })
      .in("monday_user_id", regenIds);
  }

  await supabaseAdmin
    .from("webhook_logs")
    .insert({
      step: "Rep_Photos_Synced",
      data: {
        today: laTodayISO(),
        fetched: users.length,
        upserted: base.length,
        reset_for_regen: regenIds.length,
      } as never,
    })
    .then(() => {});

  return { fetched: users.length, upserted: base.length, reset_for_regen: regenIds.length };
}
