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

/**
 * Owner-only manual weekly entry. Writes a single daily_logs row on the
 * selected week's Monday using admin client to bypass canvasser-self RLS.
 * Maps: sales -> sales, demos_sits = sits - sales, no_demo = leads - sits.
 */
export const upsertManualWeekly = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const o = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const canvasser_id = typeof o.canvasser_id === "string" ? o.canvasser_id : "";
    const week_start = typeof o.week_start === "string" ? o.week_start : "";
    const raw_leads = Math.max(0, Number(o.total_leads ?? 0) | 0);
    const raw_sits = Math.max(0, Number(o.total_sits ?? 0) | 0);
    const raw_sales = Math.max(0, Number(o.total_sales ?? 0) | 0);
    if (!/^[0-9a-f-]{36}$/i.test(canvasser_id)) throw new Error("Invalid canvasser");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) throw new Error("Invalid week");
    // Auto-clamp instead of throwing so a typo doesn't blank the app.
    const total_sales = raw_sales;
    const total_sits = Math.max(raw_sits, total_sales);
    const total_leads = Math.max(raw_leads, total_sits);
    return { canvasser_id, week_start, total_leads, total_sits, total_sales };

  })
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles").select("role").eq("user_id", context.userId);
    if (!(roles ?? []).some((r) => r.role === "owner")) throw new Error("Only owners");

    const demos_sits = data.total_sits - data.total_sales;
    const no_demo = data.total_leads - data.total_sits;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: prof } = await supabaseAdmin
      .from("profiles").select("team_id").eq("id", data.canvasser_id).maybeSingle();

    const { error } = await supabaseAdmin.from("daily_logs").upsert({
      canvasser_id: data.canvasser_id,
      team_id: prof?.team_id ?? null,
      log_date: data.week_start,
      demos_sits,
      sales: data.total_sales,
      no_demo,
    }, { onConflict: "canvasser_id,log_date" });
    if (error) throw error;
    return { ok: true };
  });
