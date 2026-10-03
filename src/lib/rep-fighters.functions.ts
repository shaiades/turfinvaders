import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Rep fighters admin (Close Kombat character-select). The owner/manager tools
 * behind the Kombat tab: pull Monday photos, generate Street Fighter cartoons
 * with Gemini, and Approve / Reject / Re-roll each one before it goes live.
 * Every fn is ADMIN only (owner/office_staff) — generation spends API budget and
 * publishes art of real employees. Same inline gate as syncBlockCards (the Close
 * Kombat doctrine); never widen it.
 */

// The admin check is inlined per handler (the Close Kombat doctrine) rather than
// a shared helper: re-typing `context.supabase` in a helper trips TS
// "excessively deep" on the Supabase query builder generics.

export type RepFighterRow = {
  monday_user_id: number;
  name: string;
  name_norm: string;
  title: string | null;
  photo_url: string | null;
  cartoon_portrait_url: string | null;
  cartoon_full_url: string | null;
  cartoon_status: string;
  cartoon_prompt: string | null;
  updated_at: string;
};

/** Every rep_photos row (pending/failed included) for the review gallery. */
export const listRepFighters = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RepFighterRow[]> => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage rep fighters.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("rep_photos")
      .select(
        "monday_user_id, name, name_norm, title, photo_url, cartoon_portrait_url, cartoon_full_url, cartoon_status, cartoon_prompt, updated_at",
      )
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []) as RepFighterRow[];
  });

/** Re-pull every Monday user's profile photo into rep_photos. */
export const syncRepPhotosFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage rep fighters.");
    }
    const { syncRepPhotos } = await import("@/lib/rep-photos.server");
    return await syncRepPhotos();
  });

const generateInput = z.object({
  // Target specific reps (the ~17 active ones), or omit to drain the "missing"
  // queue up to `limit`.
  mondayUserIds: z.array(z.number().int().positive()).max(25).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

/** Generate portrait + full-body cartoons for the given reps (or the queue). */
export const generateCartoonsFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => generateInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage rep fighters.");
    }
    const { generateRepCartoons } = await import("@/lib/rep-cartoons.server");
    return await generateRepCartoons({ mondayUserIds: data.mondayUserIds, limit: data.limit });
  });

const reviewInput = z.object({
  mondayUserId: z.number().int().positive(),
  action: z.enum(["approve", "reject", "reroll"]),
  // Optional style tweak used only on a re-roll.
  prompt: z.string().trim().max(2000).optional(),
});

/** Approve (go live), reject (clear), or re-roll (regenerate) one fighter. */
export const reviewCartoonFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reviewInput.parse(d))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("owner") && !roles.includes("office_staff")) {
      throw new Error("Only Owners or Managers can manage rep fighters.");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.action === "reroll") {
      const { generateRepCartoon } = await import("@/lib/rep-cartoons.server");
      return await generateRepCartoon(data.mondayUserId, { styleOverride: data.prompt });
    }

    const patch =
      data.action === "approve"
        ? { cartoon_status: "approved" as const }
        : {
            cartoon_status: "none" as const,
            cartoon_portrait_url: null,
            cartoon_full_url: null,
          };
    const { error } = await supabaseAdmin
      .from("rep_photos")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("monday_user_id", data.mondayUserId);
    if (error) throw new Error(error.message);
    return { ok: true as const, monday_user_id: data.mondayUserId, status: patch.cartoon_status };
  });
