import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { weeklyPoints } from "@/lib/pay";

/**
 * Aggregated per-canvasser production for the Fleet Dispatch board.
 *
 * Deliberately readable by EVERY authenticated user (owner decision,
 * 2026-07-28: "everyone should be able to see everyone's production").
 * daily_logs and leads rows stay RLS-locked (see migration 20260629213023 —
 * the visibility toggle "only controls production-metric peer views in the
 * app layer"; this function IS that app layer). Only aggregate totals per
 * canvasser leave the server — never raw rows, addresses, or lead details.
 */
export const getDispatchProduction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const log_start = typeof obj.log_start === "string" ? obj.log_start : "";
    const log_end = typeof obj.log_end === "string" ? obj.log_end : "";
    if (!day.test(log_start) || !day.test(log_end)) throw new Error("Invalid log window");
    const vol_start = typeof obj.vol_start === "string" ? obj.vol_start : "";
    const vol_end = typeof obj.vol_end === "string" ? obj.vol_end : "";
    if (Number.isNaN(Date.parse(vol_start)) || Number.isNaN(Date.parse(vol_end))) {
      throw new Error("Invalid volume window");
    }
    return { log_start, log_end, vol_start, vol_end };
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [logsR, leadsR] = await Promise.all([
      supabaseAdmin
        .from("daily_logs")
        .select("canvasser_id, demos_sits, sales, log_date")
        .gte("log_date", data.log_start)
        .lte("log_date", data.log_end),
      // Two-sided superset fetch; the COALESCE(reviewed_at, created_at)
      // re-window below is the authoritative filter (pay-engine parity).
      supabaseAdmin
        .from("leads")
        .select("canvasser_id, sale_amount, created_at, reviewed_at")
        .eq("status", "confirmed")
        .or(
          `and(created_at.gte.${data.vol_start},created_at.lt.${data.vol_end}),and(reviewed_at.gte.${data.vol_start},reviewed_at.lt.${data.vol_end})`,
        ),
    ]);
    if (logsR.error) throw logsR.error;
    if (leadsR.error) throw leadsR.error;

    const points: Record<string, number> = {};
    for (const l of logsR.data ?? []) {
      if (!l.canvasser_id) continue;
      const pts = weeklyPoints(l.demos_sits ?? 0, l.sales ?? 0);
      if (pts > 0) points[l.canvasser_id] = (points[l.canvasser_id] ?? 0) + pts;
    }

    const volStartMs = Date.parse(data.vol_start);
    const volEndMs = Date.parse(data.vol_end);
    const volume: Record<string, number> = {};
    for (const l of leadsR.data ?? []) {
      if (!l.canvasser_id) continue;
      const at = Date.parse(l.reviewed_at ?? l.created_at ?? "");
      if (Number.isNaN(at) || at < volStartMs || at >= volEndMs) continue;
      volume[l.canvasser_id] = (volume[l.canvasser_id] ?? 0) + Number(l.sale_amount ?? 0);
    }

    return { points, volume };
  });
