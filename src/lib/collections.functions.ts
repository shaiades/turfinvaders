import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { CollectionsSyncSummary } from "@/lib/collections.server";

/**
 * Collections sync: pull "<Month> Collections <YYYY>" board rows from Monday
 * into report_collections (God Mode's anticipated-vs-collected source).
 * scope "active" = the current + previous month's boards (seconds, safe to
 * spam); scope "all" = every parseable Collections board back to 2023
 * (~40 boards, one page each — lighter than the Block "Full history" walk);
 * boardIds = bounded manual chunks if a backfill ever outgrows the budget.
 */
const syncInput = z.object({
  scope: z.enum(["active", "all"]).default("active"),
  boardIds: z.array(z.string().regex(/^\d+$/)).max(5).optional(),
});

/**
 * When did collections money last move? The Collections boards have no
 * webhooks — rows change ONLY when an admin runs a sync — so God Mode's
 * freshness caption reads this trail, same doctrine as getKombatSyncInfo.
 */
export const getCollectionsSyncInfo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ lastSyncedAt: string | null }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("webhook_logs")
      .select("created_at")
      .eq("step", "Collections_Synced")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { lastSyncedAt: data?.created_at ?? null };
  });

export const syncCollections = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => syncInput.parse(data))
  .handler(async ({ data, context }): Promise<CollectionsSyncSummary> => {
    // ADMIN only (owner/office_staff): the sync spends Monday API budget and
    // rewrites report_collections. Same gate as syncBlockCards — never widen
    // this check (see roles.ts ADMIN_ROLES).
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can sync Collections.");
    }

    const { syncCollectionsBoards } = await import("@/lib/collections.server");
    return syncCollectionsBoards(data);
  });
