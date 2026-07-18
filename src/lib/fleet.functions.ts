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

/** Row shape returned by the calc_weekly_paycheck RPC. */
export type PaycheckRow = {
  week_start: string;
  week_end: string;
  sits: number;
  points: number;
  sales: number;
  sale_price_total: number;
  hours: number;
  hourly_rate: number;
  base_pay: number;
  commission_rate: number;
  commission: number;
  sit_bonus: number;
  monster_bonus: number;
  total_pay: number;
  rank: string;
};

export type PaycheckResult = {
  canvasser_id: string;
  paycheck: PaycheckRow | null;
  error: string | null;
};

/**
 * Batched weekly paychecks for the Payroll Ledger and Last Week's Results —
 * same engine as getWeeklyPaycheck (calc_weekly_paycheck via service role),
 * one server round-trip for many canvassers. Authorization mirrors the
 * Payroll tab audience: owners and office staff may fetch any canvasser,
 * captains only their own team, everyone else only themselves. Unauthorized
 * ids are silently dropped from the result rather than failing the batch.
 */
export const getWeeklyPaychecks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const o = (data && typeof data === "object") ? data as Record<string, unknown> : {};
    const week_start = typeof o.week_start === "string" ? o.week_start : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week_start)) throw new Error("Invalid week");
    const raw = Array.isArray(o.canvasser_ids) ? o.canvasser_ids : [];
    if (raw.length > 300) throw new Error("Too many canvassers");
    const canvasser_ids = raw.map((id) => {
      if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid canvasser id");
      return id;
    });
    return { week_start, canvasser_ids };
  })
  .handler(async ({ data, context }) => {
    const { data: roles, error: rolesErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (rolesErr) throw rolesErr;
    const roleSet = new Set((roles ?? []).map((r) => r.role));

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let allowedIds = data.canvasser_ids;
    if (roleSet.has("owner") || roleSet.has("office_staff")) {
      // Full access — the Payroll tab audience.
    } else if (roleSet.has("captain")) {
      const { data: meProf } = await supabaseAdmin
        .from("profiles").select("team_id").eq("id", context.userId).maybeSingle();
      const myTeam = meProf?.team_id ?? null;
      const { data: teamProfiles } = myTeam
        ? await supabaseAdmin
            .from("profiles").select("id").in("id", data.canvasser_ids).eq("team_id", myTeam)
        : { data: [] as { id: string }[] };
      const permitted = new Set((teamProfiles ?? []).map((p) => p.id));
      permitted.add(context.userId);
      allowedIds = data.canvasser_ids.filter((id) => permitted.has(id));
    } else {
      allowedIds = data.canvasser_ids.filter((id) => id === context.userId);
    }

    const results: PaycheckResult[] = new Array(allowedIds.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < allowedIds.length) {
        const idx = cursor++;
        const id = allowedIds[idx];
        try {
          const { data: rows, error } = await supabaseAdmin.rpc("calc_weekly_paycheck", {
            _canvasser_id: id,
            _week_start: data.week_start,
          });
          if (error) throw error;
          results[idx] = { canvasser_id: id, paycheck: (rows?.[0] as PaycheckRow | undefined) ?? null, error: null };
        } catch (e) {
          results[idx] = { canvasser_id: id, paycheck: null, error: e instanceof Error ? e.message : String(e) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(allowedIds.length, 1)) }, () => worker()));
    return { week_start: data.week_start, results };
  });
