import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { MissingReport, OohConfig } from "@/lib/ooh";

/**
 * OOH admin/config server fns. Config read is open to any signed-in user (the
 * rep "Report" button needs the form URL + mode, never the API token). Push
 * lead, queue resolution and the missing-reports scan are owner/office_staff
 * only. Supabase-first; Monday is best-effort, same doctrine as Respawn.
 */

type AdminClient = {
  from: (t: string) => {
    select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown }> };
  };
};

async function assertAdmin(supabase: AdminClient, userId: string): Promise<void> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  if (!roles.includes("owner") && !roles.includes("office_staff")) {
    throw new Error("Only the office (owner / office_staff) can use Dispo admin tools.");
  }
}

async function settings(): Promise<{
  token: string;
  mode: OohConfig["mode"];
  dispatchMode: OohConfig["dispatchMode"];
  formUrl: string | null;
  autocreate: boolean;
  activeSd: string | null;
  activeOc: string | null;
  goLiveAt: string | null;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select(
      "monday_api_token, ooh_writeback_mode, live_dispatch_mode, ooh_form_url, ooh_autocreate, active_monday_board_sd, active_monday_board_oc, ooh_go_live_at",
    )
    .maybeSingle();
  const mode = ((data?.ooh_writeback_mode as string | null) ?? "off") as OohConfig["mode"];
  const dispatchMode = ((data?.live_dispatch_mode as string | null) ??
    "off") as OohConfig["dispatchMode"];
  const oneOf = (m: string): OohConfig["mode"] => (m === "dry_run" || m === "live" ? m : "off");
  return {
    token: ((data?.monday_api_token as string | null) ?? "").trim(),
    mode: oneOf(mode),
    dispatchMode: oneOf(dispatchMode),
    formUrl: (data?.ooh_form_url as string | null) ?? null,
    autocreate: (data?.ooh_autocreate as boolean | null) ?? false,
    activeSd: (data?.active_monday_board_sd as string | null) ?? null,
    activeOc: (data?.active_monday_board_oc as string | null) ?? null,
    goLiveAt: (data?.ooh_go_live_at as string | null) ?? null,
  };
}

/** Non-sensitive config for the UI (never returns the Monday token). */
export const getOohConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<OohConfig> => {
    const s = await settings();
    return {
      mode: s.mode,
      dispatchMode: s.dispatchMode,
      formUrl: s.formUrl,
      autocreate: s.autocreate,
    };
  });

const pushInput = z.object({
  boardId: z.string().regex(/^\d+$/),
  itemId: z.string().regex(/^\d+$/),
});

/** Manager override: issue (press "Iss" on) a specific lead item right now.
 *  The item id is resolved by `nextLeadForRep` first (the rep's NEXT not-issued
 *  lead), so this never re-presses Iss on an already-issued missing lead. */
export const pushLeadIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pushInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const s = await settings();
    if (!s.token) throw new Error("No Monday API token configured.");
    const { pushLeadIss } = await import("@/lib/ooh.server");
    await pushLeadIss(s.token, data.boardId, data.itemId);
    return { ok: true };
  });

const nextLeadInput = z.object({
  boardId: z.string().regex(/^\d+$/),
  repName: z.string().min(1).max(200),
});

export type NextLeadResult = {
  itemId: string;
  name: string;
  apptLabel: string | null;
} | null;

/** Resolve the rep's NEXT not-issued lead (earliest appointment after now) so
 *  the admin UI can show its name + time before confirming a Push (#12). */
export const nextLeadForRep = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => nextLeadInput.parse(d))
  .handler(async ({ data, context }): Promise<NextLeadResult> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const s = await settings();
    if (!s.token) throw new Error("No Monday API token configured.");
    const { fetchNextLeadForRep } = await import("@/lib/ooh.server");
    const next = await fetchNextLeadForRep(s.token, data.boardId, data.repName);
    return next ? { itemId: next.itemId, name: next.name, apptLabel: next.apptLabel } : null;
  });

const resolveInput = z.object({
  id: z.string().uuid(),
  action: z.enum(["dismissed", "processed"]),
});

/** Resolve an admin-queue submission (dismiss or mark handled). */
export const resolveOohQueueItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => resolveInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("ooh_report_queue")
      .update({
        status: data.action,
        decided_by: context.userId,
        decided_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** The missing-reports list: issued leads (go-live onward) whose appointment
 *  has passed with no report, across the current SD + OC blocks. */
export const listMissingReports = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MissingReport[]> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const s = await settings();
    if (!s.token) return [];
    const { fetchMissingReportsForBoard } = await import("@/lib/ooh.server");
    const sinceMs = s.goLiveAt ? Date.parse(s.goLiveAt) : null;
    const out: MissingReport[] = [];
    if (s.activeSd)
      out.push(...(await fetchMissingReportsForBoard(s.token, s.activeSd, "SD", sinceMs)));
    if (s.activeOc)
      out.push(...(await fetchMissingReportsForBoard(s.token, s.activeOc, "OC", sinceMs)));
    return out;
  });
