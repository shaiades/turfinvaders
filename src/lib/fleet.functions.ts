import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Owner-only profile deletion. Removes the auth user (cascades to profile,
 * user_roles, daily_logs FK, etc.) so ghost CSV-imported profiles can be
 * cleared from Fleet Manager.
 */
export const deleteProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid profile id");
    return { id };
  })
  .handler(async ({ data, context }) => {
    // Verify caller is an owner
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw rolesErr;
    const isOwner = (roles ?? []).some((r) => r.role === "owner");
    if (!isOwner) throw new Error("Only owners can delete profiles");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.id);
    if (error) {
      // Fallback: hard-delete profile row even if auth user is missing
      await supabaseAdmin.from("profiles").delete().eq("id", data.id);
    }
    return { ok: true };
  });

/**
 * Owner-only Van (team) deletion. FK constraints set profiles.team_id and
 * daily_logs.team_id to NULL, so members survive as Unassigned.
 */
export const deleteVan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid van id");
    return { id };
  })
  .handler(async ({ data, context }) => {
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw rolesErr;
    const isOwner = (roles ?? []).some((r) => r.role === "owner");
    if (!isOwner) throw new Error("Only owners can delete vans");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("teams").delete().eq("id", data.id);
    if (error) throw error;
    return { ok: true };
  });
