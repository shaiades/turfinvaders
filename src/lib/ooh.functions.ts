import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { attendanceOverrideKey, type MissingReport, type OohConfig } from "@/lib/ooh";
import { laTodayISO } from "@/lib/dates";

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

/** Owner-ONLY gate — stricter than assertAdmin (office_staff excluded). The
 *  live-dispatch switch flips whether Turf Invaders writes to live Monday, so
 *  it's the owner's lever alone (owner mandate 2026-10-07). */
async function assertOwner(supabase: AdminClient, userId: string): Promise<void> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  if (!roles.includes("owner")) {
    throw new Error("Only the owner can change the live-dispatch mode.");
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

const dispatchModeInput = z.object({ mode: z.enum(["off", "dry_run", "live"]) });

/** Set system_settings.live_dispatch_mode (owner only). The Dispo chip cycles
 *  off → dry_run → live; this persists the chosen value. Returns the saved mode
 *  so the UI can confirm. */
export const setDispatchMode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => dispatchModeInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; mode: OohConfig["dispatchMode"] }> => {
    await assertOwner(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // system_settings is a singleton keyed by a boolean id (always true).
    const { error } = await supabaseAdmin
      .from("system_settings")
      .update({ live_dispatch_mode: data.mode })
      .eq("id", true);
    if (error) throw new Error(error.message);
    return { ok: true, mode: data.mode };
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

const noteInput = z.object({ id: z.string().uuid() });

/** Rescue a skipped report's note: post its free-text as an activity Update on
 *  the matched block card (NO disposition change — never clobbers the office's
 *  work), then mark the queue item handled. Only valid for rows with a matched,
 *  resolved card (target_item_id + board_id) — e.g. "already dispositioned by
 *  office" or a non-allow-listed board. Idempotent per form item. */
export const addOohQueueNote = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => noteInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error: readErr } = await supabaseAdmin
      .from("ooh_report_queue")
      .select("target_item_id, board_id, details_line, rep_name, form_item_id")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!row) throw new Error("Report not found.");
    const targetItemId = ((row.target_item_id as string | null) ?? "").trim();
    const note = ((row.details_line as string | null) ?? "").trim();
    if (!targetItemId)
      throw new Error("No matched card for this report — add the note in Monday by hand.");
    if (!note) throw new Error("This report has no note text to add.");
    const s = await settings();
    if (!s.token) throw new Error("No Monday API token configured.");
    const rep = ((row.rep_name as string | null) ?? "").trim() || "rep";
    const formItemId = ((row.form_item_id as string | null) ?? "").trim() || data.id;
    const { postCardUpdate } = await import("@/lib/ooh.server");
    await postCardUpdate(
      s.token,
      targetItemId,
      `Dispo note (added by office) from ${rep}: ${note}`,
      `ooh-note-${formItemId}`,
    );
    const { error: updErr } = await supabaseAdmin
      .from("ooh_report_queue")
      .update({
        status: "processed",
        decided_by: context.userId,
        decided_at: new Date().toISOString(),
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);
    return { ok: true };
  });

const overrideInput = z.object({
  office: z.enum(["SD", "OC"]),
  repName: z.string().min(1).max(200),
  status: z.enum(["on", "off"]),
});

/** Flip a rep On/Off for TODAY (the 10/6 playbook's attendance override, PR
 *  #363's unshipped piece). The dispatcher lays the row over the Monday
 *  attendance board in live issuing + the watchdog, so the app always beats the
 *  board — including turning ON a rep the board doesn't list. One row per
 *  (day, office, rep); flipping again replaces it. Owner / office_staff. */
export const setAttendanceOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => overrideInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const repKey = attendanceOverrideKey(data.repName);
    if (!repKey) throw new Error("Rep name is required.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("attendance_overrides").upsert(
      {
        override_date: laTodayISO(),
        office: data.office,
        rep_name: data.repName.trim(),
        rep_key: repKey,
        status: data.status,
        created_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "override_date,office,rep_key" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const clearOverrideInput = z.object({ id: z.string().uuid() });

/** Remove an attendance override — the Monday board's own word applies again. */
export const clearAttendanceOverride = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => clearOverrideInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("attendance_overrides").delete().eq("id", data.id);
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
