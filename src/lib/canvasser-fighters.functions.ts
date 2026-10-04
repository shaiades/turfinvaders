import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Canvasser fighters (Close Kombat character-select — field crew). Mirrors the
 * rep fighter admin (rep-fighters.functions.ts) but the source photo is an
 * uploaded selfie, not a Monday pull:
 *  - uploadMyCanvasserPhotoFn — SELF-SERVE: any signed-in player sets their own
 *    fighter (profile_id is forced to the caller; they can never target someone
 *    else).
 *  - uploadCanvasserPhotoFn / generateCanvasserCartoonFn / listCanvasserFightersFn
 *    — ADMIN only (owner/office_staff): upload or re-roll for anyone, and the
 *    manage gallery.
 * Generation spends Gemini budget and publishes art of a real person, so the
 * admin fns carry the same inline owner/office_staff gate as the rep fns.
 */

// A base64 image data URL. ~8MB of bytes ≈ 11MB of base64 text; cap generously.
const dataUrlSchema = z
  .string()
  .trim()
  .min(32)
  .max(15_000_000)
  .refine((s) => s.startsWith("data:image/"), "Must be an image data URL");

/** Self-serve: set MY OWN fighter from an uploaded selfie (any signed-in player). */
export const uploadMyCanvasserPhotoFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ dataUrl: dataUrlSchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { saveCanvasserPhotoAndGenerate } = await import("@/lib/canvasser-cartoons.server");
    return await saveCanvasserPhotoAndGenerate(context.userId, data.dataUrl);
  });

const adminUploadInput = z.object({
  profileId: z.string().uuid(),
  dataUrl: dataUrlSchema,
});

/** Admin: upload a selfie + generate a fighter for any canvasser. */
export const uploadCanvasserPhotoFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => adminUploadInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage canvasser fighters.");
    }
    const { saveCanvasserPhotoAndGenerate } = await import("@/lib/canvasser-cartoons.server");
    return await saveCanvasserPhotoAndGenerate(data.profileId, data.dataUrl);
  });

const regenInput = z.object({
  profileId: z.string().uuid(),
  // Optional style tweak used only on a re-roll.
  prompt: z.string().trim().max(2000).optional(),
});

/** Admin: re-roll an existing canvasser fighter (regenerate from the stored selfie). */
export const generateCanvasserCartoonFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => regenInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage canvasser fighters.");
    }
    const { generateCanvasserCartoon } = await import("@/lib/canvasser-cartoons.server");
    return await generateCanvasserCartoon(data.profileId, { styleOverride: data.prompt });
  });

const rerollAllInput = z.object({ limit: z.number().int().min(1).max(10).optional() });

/** Admin: re-roll fighters whose background color is stale vs their current van. */
export const rerollCanvasserCartoonsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => rerollAllInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage canvasser fighters.");
    }
    const { rerollOutdatedCanvasserCartoons } = await import("@/lib/canvasser-cartoons.server");
    return await rerollOutdatedCanvasserCartoons({ limit: data.limit });
  });

export type CanvasserFighterRow = {
  profile_id: string;
  name: string;
  office: string | null;
  role: string | null;
  cartoon_portrait_url: string | null;
  cartoon_full_url: string | null;
  cartoon_status: string;
  updated_at: string | null;
};

// Door-knocking crew only — sales reps get their fighter from the Monday
// pipeline, and the admin tier isn't on the board.
const FIELD_ROLES = new Set(["canvasser", "confirmer", "captain"]);

/** Every field-crew player with their fighter status, for the manage gallery. */
export const listCanvasserFightersFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<CanvasserFighterRow[]> => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const myRoles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!myRoles.includes("owner") && !myRoles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage canvasser fighters.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [
      { data: profs, error: pErr },
      { data: allRoles, error: rErr },
      { data: photos, error: cErr },
    ] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, display_name, office_location, is_active, is_placeholder")
        .eq("is_active", true)
        .eq("is_placeholder", false),
      supabaseAdmin.from("user_roles").select("user_id, role"),
      supabaseAdmin
        .from("canvasser_photos")
        .select("profile_id, cartoon_portrait_url, cartoon_full_url, cartoon_status, updated_at"),
    ]);
    if (pErr) throw new Error(pErr.message);
    if (rErr) throw new Error(rErr.message);
    if (cErr) throw new Error(cErr.message);

    const rolesByUser = new Map<string, string[]>();
    for (const r of allRoles ?? []) {
      const list = rolesByUser.get(r.user_id) ?? [];
      list.push(r.role);
      rolesByUser.set(r.user_id, list);
    }
    const photoByProfile = new Map((photos ?? []).map((p) => [p.profile_id, p]));

    const rows: CanvasserFighterRow[] = [];
    for (const p of profs ?? []) {
      const roles = rolesByUser.get(p.id) ?? [];
      // Skip the admin tier and reps; keep door-knockers (incl. captains).
      if (roles.includes("owner") || roles.includes("office_staff")) continue;
      if (!roles.some((r) => FIELD_ROLES.has(r))) continue;
      const photo = photoByProfile.get(p.id);
      rows.push({
        profile_id: p.id,
        name: p.display_name ?? "Unknown",
        office: p.office_location ?? null,
        role: roles.find((r) => FIELD_ROLES.has(r)) ?? null,
        cartoon_portrait_url: photo?.cartoon_portrait_url ?? null,
        cartoon_full_url: photo?.cartoon_full_url ?? null,
        cartoon_status: photo?.cartoon_status ?? "none",
        updated_at: photo?.updated_at ?? null,
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  });
