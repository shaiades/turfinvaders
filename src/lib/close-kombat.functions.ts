import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SyncSummary } from "@/lib/block-cards.server";

/**
 * Close Kombat sync: pull Block-board cards from Monday into block_cards.
 * scope "active" = this week's two boards PLUS last week's (the office
 * finalizes Saturday's sales through Monday — same grace window the
 * webhook rotation keeps; seconds, safe to spam);
 * scope "all" = every SD/OC Block board Monday still lists (backfill —
 * up to ~50 boards, sequential); boardIds = bounded manual chunks if a
 * full-history run ever outgrows the serverless time budget.
 */
const syncInput = z.object({
  scope: z.enum(["active", "all"]).default("active"),
  boardIds: z.array(z.string().regex(/^\d+$/)).max(5).optional(),
});

/**
 * When did the money stamps (WCC cancels + report_reps splits) last move?
 * Sales Report boards have no webhooks — those stamps change ONLY when an
 * admin runs a sync — so the board's "Live" chip says nothing about their
 * freshness (rep audit R-5). Reads the sync trail on the admin client:
 * webhook_logs is not rep-readable, but the timestamp alone is harmless
 * and exactly what stops a rep trusting a stale cancel count.
 */
export const getKombatSyncInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ lastSyncedAt: string | null }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("webhook_logs")
      .select("created_at")
      .eq("step", "Block_Cards_Synced")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { lastSyncedAt: data?.created_at ?? null };
  });

export const syncBlockCards = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => syncInput.parse(data))
  .handler(async ({ data, context }): Promise<SyncSummary> => {
    // ADMIN only (owner/office_staff): the sync spends Monday API budget and
    // rewrites block_cards. Captains and sales reps read the stats but never
    // drive ingestion — never widen this check (see roles.ts ADMIN_ROLES).
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can sync Close Kombat.");
    }

    const { syncBoardsToBlockCards } = await import("@/lib/block-cards.server");
    return syncBoardsToBlockCards(data);
  });
