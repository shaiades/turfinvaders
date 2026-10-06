import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Blocking profile-photo gate — server side (owner directive 2026-10-06: "the
 * photo step has to be obvious for every user"). The gate's per-user decision is
 * computed on the client (own canvasser_photos row + the approved-cartoon map,
 * both readable under RLS); these fns cover the three things the client can't do:
 *
 *  - getPhotoGateConfigFn — read the "Remind me later" escape-valve flag.
 *    system_settings is OWNER-only under RLS, so a canvasser/rep can't read it
 *    directly; this reads it with the service role for any signed-in user.
 *  - setPhotoRemindLaterFn — admin toggle for that flag.
 *  - listMissingPhotosFn — the admin roster of players still without a photo
 *    ("Users without a photo: N"), so Jose Miranda shows up until he adds one.
 */

const GATED_ROLES = new Set(["canvasser", "confirmer", "captain", "sales_rep", "office_staff"]);

/** Read the remind-later flag for the signed-in user (service role — the table
 *  is owner-only under RLS). Defaults to false (fully blocking) on any miss. */
export const getPhotoGateConfigFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ remindLaterEnabled: boolean }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("system_settings")
      .select("profile_photo_remind_later")
      .maybeSingle();
    if (error) return { remindLaterEnabled: false };
    return { remindLaterEnabled: data?.profile_photo_remind_later === true };
  });

/** Admin: turn the "Remind me later" escape valve on or off. */
export const setPhotoRemindLaterFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; enabled: boolean }> => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can change this.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Singleton row (id = true). Upsert so a never-seeded settings row still works.
    const { error } = await supabaseAdmin
      .from("system_settings")
      .upsert({ id: true, profile_photo_remind_later: data.enabled }, { onConflict: "id" });
    if (error) throw new Error(error.message);
    return { ok: true, enabled: data.enabled };
  });

export type MissingPhotoRow = {
  profile_id: string;
  name: string;
  role: string | null;
  office: string | null;
};

/**
 * Admin: every active, real (non-placeholder) player in a gated role who still
 * has no photo. "Has a photo" mirrors the client gate exactly: an APPROVED
 * cartoon in either cast (rep_photos / canvasser_photos, keyed by normalized
 * name) OR a self-uploaded selfie on file (canvasser_photos.photo_path) — so a
 * row clears the moment the player uploads, even before the cartoon finishes.
 */
export const listMissingPhotosFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ total: number; missing: MissingPhotoRow[] }> => {
    const { data: myRoles, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const mine = (myRoles ?? []).map((r: { role: string }) => r.role);
    if (!mine.includes("owner") && !mine.includes("office_staff")) {
      throw new Error("Only Owners or Managers can see this.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { normalizeName } = await import("@/lib/utils");

    const [
      { data: profs, error: pErr },
      { data: allRoles, error: rErr },
      { data: canv, error: cErr },
      { data: reps, error: repErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, display_name, office_location, is_active, is_placeholder")
        .eq("is_active", true)
        .eq("is_placeholder", false),
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin
        .from("canvasser_photos")
        .select(
          "profile_id, name_norm, photo_path, cartoon_status, cartoon_portrait_url, cartoon_full_url",
        ),
      supabaseAdmin
        .from("rep_photos")
        .select("name_norm, cartoon_status, cartoon_portrait_url, cartoon_full_url"),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (rErr) throw new Error(rErr.message);
    if (cErr) throw new Error(cErr.message);
    if (repErr) throw new Error(repErr.message);

    const rolesByUser = new Map<string, string[]>();
    for (const r of allRoles ?? []) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role);
      rolesByUser.set(r.user_id, list);
    }

    // Names with an approved cartoon that actually has art.
    const hasArt = (p: string | null, f: string | null) => !!p || !!f;
    const approvedNames = new Set<string>();
    for (const r of reps ?? []) {
      if (r.cartoon_status === "approved" && hasArt(r.cartoon_portrait_url, r.cartoon_full_url)) {
        approvedNames.add(r.name_norm);
      }
    }
    for (const r of canv ?? []) {
      if (r.cartoon_status === "approved" && hasArt(r.cartoon_portrait_url, r.cartoon_full_url)) {
        approvedNames.add(r.name_norm);
      }
    }
    // Profiles that have uploaded a selfie (photo on file), regardless of cartoon.
    const selfieByProfile = new Set(
      (canv ?? []).filter((r) => !!r.photo_path).map((r) => r.profile_id),
    );

    const missing: MissingPhotoRow[] = [];
    let total = 0;
    for (const p of profs ?? []) {
      const roles = rolesByUser.get(p.id) ?? [];
      if (roles.includes("owner")) continue; // owner is exempt from the gate
      const gatedRole = roles.find((r) => GATED_ROLES.has(r));
      if (!gatedRole) continue;
      total++;
      const nameNorm = normalizeName(p.display_name ?? "");
      const hasPhoto = selfieByProfile.has(p.id) || approvedNames.has(nameNorm);
      if (!hasPhoto) {
        missing.push({
          profile_id: p.id,
          name: p.display_name ?? "Unknown",
          role: gatedRole,
          office: p.office_location ?? null,
        });
      }
    }
    missing.sort((a, b) => a.name.localeCompare(b.name));
    return { total, missing };
  });
