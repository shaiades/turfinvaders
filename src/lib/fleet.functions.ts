import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

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
 * If the user holds the 'captain' role but is no longer captain_id of any
 * van, replace that role with 'canvasser'. Owners and Admins are never
 * touched, and their profile/team assignment is left alone — an outgoing
 * captain stays on the van roster as a regular member.
 */
async function demoteCaptainIfNoVan(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<boolean> {
  const { data: roleRows, error: rolesErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (rolesErr) throw rolesErr;
  const roles = (roleRows ?? []).map((r) => r.role as string);
  if (!roles.includes("captain") || roles.includes("owner") || roles.includes("office_staff"))
    return false;

  const { data: stillLeads, error: teamsErr } = await admin
    .from("teams")
    .select("id")
    .eq("captain_id", userId)
    .limit(1);
  if (teamsErr) throw teamsErr;
  if ((stillLeads ?? []).length > 0) return false;

  const { error: delErr } = await admin
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role", "captain");
  if (delErr) throw delErr;
  if (!roles.includes("canvasser")) {
    const { error: insErr } = await admin
      .from("user_roles")
      .insert({ user_id: userId, role: "canvasser" });
    if (insErr) throw insErr;
  }
  return true;
}

/**
 * Owner-only captain assignment with role hygiene. daily_logs/leads RLS only
 * grants captain access where teams.captain_id matches, so user_roles must
 * track it: the incoming captain is promoted to 'captain' (and joins the van,
 * inheriting its office), and the outgoing captain drops back to 'canvasser'
 * unless they still lead another van or hold a higher role.
 */
export const setVanCaptain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const van_id = typeof obj.van_id === "string" ? obj.van_id : "";
    const captain_id = typeof obj.captain_id === "string" ? obj.captain_id : null;
    if (!/^[0-9a-f-]{36}$/i.test(van_id)) throw new Error("Invalid van id");
    if (captain_id !== null && !/^[0-9a-f-]{36}$/i.test(captain_id))
      throw new Error("Invalid captain id");
    return { van_id, captain_id };
  })
  .handler(async ({ data, context }) => {
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw rolesErr;
    if (!(roles ?? []).some((r) => r.role === "owner"))
      throw new Error("Only owners can assign captains");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: van, error: vanErr } = await supabaseAdmin
      .from("teams")
      .select("id, office_location, captain_id")
      .eq("id", data.van_id)
      .maybeSingle();
    if (vanErr) throw vanErr;
    if (!van) throw new Error("Van not found");
    const previousCaptainId = van.captain_id;

    const { error: teamErr } = await supabaseAdmin
      .from("teams")
      .update({ captain_id: data.captain_id })
      .eq("id", data.van_id);
    if (teamErr) throw teamErr;

    if (data.captain_id) {
      const { data: newRoleRows, error: newRolesErr } = await supabaseAdmin
        .from("user_roles")
        .select("role")
        .eq("user_id", data.captain_id);
      if (newRolesErr) throw newRolesErr;
      const newRoles = (newRoleRows ?? []).map((r) => r.role as string);
      if (
        !newRoles.includes("captain") &&
        !newRoles.includes("owner") &&
        !newRoles.includes("office_staff")
      ) {
        const { error: delErr } = await supabaseAdmin
          .from("user_roles")
          .delete()
          .eq("user_id", data.captain_id)
          .eq("role", "canvasser");
        if (delErr) throw delErr;
        const { error: insErr } = await supabaseAdmin
          .from("user_roles")
          .insert({ user_id: data.captain_id, role: "captain" });
        if (insErr) throw insErr;
      }
      const patch: { team_id: string; office_location?: string } = { team_id: data.van_id };
      if (van.office_location) patch.office_location = van.office_location;
      const { error: profErr } = await supabaseAdmin
        .from("profiles")
        .update(patch)
        .eq("id", data.captain_id);
      if (profErr) throw profErr;
    }

    let demoted_previous = false;
    if (previousCaptainId && previousCaptainId !== data.captain_id) {
      demoted_previous = await demoteCaptainIfNoVan(supabaseAdmin, previousCaptainId);
    }
    return { ok: true, demoted_previous };
  });

/**
 * Owner-only cleanup for captains stranded by pre-fix reassignments: holds
 * the 'captain' role but is captain_id of no van. Verifies that state
 * server-side before demoting to canvasser.
 */
export const demoteStrandedCaptain = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const id = typeof obj.id === "string" ? obj.id : "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid user id");
    return { id };
  })
  .handler(async ({ data, context }) => {
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw rolesErr;
    if (!(roles ?? []).some((r) => r.role === "owner"))
      throw new Error("Only owners can demote captains");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const demoted = await demoteCaptainIfNoVan(supabaseAdmin, data.id);
    if (!demoted) throw new Error("Not demoted — user still leads a van or holds a protected role");
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

/**
 * Compute a canvasser's weekly paycheck. The underlying SECURITY DEFINER
 * function is no longer executable by authenticated users directly — callers
 * must go through this server fn, which enforces role checks and invokes the
 * RPC via the service-role client.
 */
export const getWeeklyPaycheck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const o = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const canvasser_id = typeof o.canvasser_id === "string" ? o.canvasser_id : "";
    const week_start = typeof o.week_start === "string" ? o.week_start : "";
    if (!/^[0-9a-f-]{36}$/i.test(canvasser_id)) throw new Error("Invalid canvasser");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) throw new Error("Invalid week");
    return { canvasser_id, week_start };
  })
  .handler(async ({ data, context }) => {
    // Caller must be the canvasser themselves, an owner, or a captain of their team.
    const [rolesR, meProfR, targetProfR] = await Promise.all([
      context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
      context.supabase.from("profiles").select("team_id").eq("id", context.userId).maybeSingle(),
      context.supabase.from("profiles").select("team_id").eq("id", data.canvasser_id).maybeSingle(),
    ]);
    const roles = (rolesR.data ?? []).map((r) => r.role);
    const isOwner = roles.includes("owner");
    const isCaptain = roles.includes("captain");
    const isSelf = context.userId === data.canvasser_id;
    const sameTeam = !!meProfR.data?.team_id && meProfR.data.team_id === targetProfR.data?.team_id;
    if (!isSelf && !isOwner && !(isCaptain && sameTeam)) {
      throw new Error("Not authorized");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin.rpc("calc_weekly_paycheck", {
      _canvasser_id: data.canvasser_id,
      _week_start: data.week_start,
    });
    if (error) throw error;
    return rows?.[0] ?? null;
  });
