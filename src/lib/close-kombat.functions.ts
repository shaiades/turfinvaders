import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { SyncSummary } from "@/lib/block-cards.server";

/**
 * Close Kombat sync: pull Block-board cards from Monday into block_cards.
 * scope "active" = this week's two boards (seconds, safe to spam);
 * scope "all" = every SD/OC Block board Monday still lists (backfill —
 * up to ~50 boards, sequential); boardIds = bounded manual chunks if a
 * full-history run ever outgrows the serverless time budget.
 */
const syncInput = z.object({
  scope: z.enum(["active", "all"]).default("active"),
  boardIds: z.array(z.string().regex(/^\d+$/)).max(5).optional(),
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
      throw new Error("Only Owners or Office Staff can sync Close Kombat.");
    }

    const { syncBoardsToBlockCards } = await import("@/lib/block-cards.server");
    return syncBoardsToBlockCards(data);
  });
