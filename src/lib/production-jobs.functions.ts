import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ProductionSyncSummary } from "@/lib/production-jobs.server";

/**
 * Production-board sync: mirror the Monday Production board into
 * production_jobs (+ admin-only notes) for the Weekly Action Plan. The
 * Vercel cron (refresh-action-plans) runs it daily at 6 AM PT and Sunday
 * 6 PM PT; this server fn is the admin's on-demand button.
 */

/**
 * When did the plan data last move? The Production board has no webhook —
 * rows change only on a cron or admin sync — so the Plan tab's "Last
 * updated" caption reads this trail (getKombatSyncInfo doctrine).
 */
export const getProductionSyncInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ lastSyncedAt: string | null }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("webhook_logs")
      .select("created_at")
      .eq("step", "Production_Jobs_Synced")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { lastSyncedAt: data?.created_at ?? null };
  });

export const syncProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<ProductionSyncSummary> => {
    // ADMIN only (owner/office_staff): the sync spends Monday API budget,
    // rewrites production_jobs, and can Monday-notify PMs. Same gate as
    // syncBlockCards/syncCollections — never widen it.
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can sync Production.");
    }

    const { syncProductionJobs } = await import("@/lib/production-jobs.server");
    try {
      return await syncProductionJobs();
    } catch (err) {
      // Same failure trail the cron writes (cron doctrine) — separate step
      // so the catch-up/"Last updated" readers of Production_Jobs_Synced
      // never see a failure row.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { laTodayISO } = await import("@/lib/dates");
      await supabaseAdmin
        .from("webhook_logs")
        .insert({
          step: "Production_Jobs_Sync_Failed",
          data: {
            today: laTodayISO(),
            error: err instanceof Error ? err.message : String(err),
          } as never,
        })
        .then(() => {});
      throw err;
    }
  });
