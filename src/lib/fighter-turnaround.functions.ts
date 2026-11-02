import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Spin-frame generation for the stats-page turntable (owner 2026-11-02).
 * One admin fn covering BOTH casts: each call draws the 7 missing rotation
 * views for a bounded batch of approved fighters and reports `remaining`,
 * so the admin button loops it dry — the same drain pattern as
 * rerollCanvasserCartoonsFn. Generation spends Gemini budget (7 image gens
 * per fighter), so it carries the same inline owner/office_staff gate as
 * the other fighter fns.
 */

const input = z.object({ limit: z.number().int().min(1).max(3).optional() });

export const generateTurnaroundsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => input.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can generate fighter spin frames.");
    }
    const { generateMissingTurnarounds } = await import("@/lib/fighter-turnaround.server");
    return await generateMissingTurnarounds({ limit: data.limit });
  });
