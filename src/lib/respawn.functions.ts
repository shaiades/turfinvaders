import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { laWeekStartISO } from "@/lib/dates";
import {
  isLateForWeek,
  isMondayISO,
  normalizeShifts,
  officeToRep,
  type RepOffice,
  type RespawnStatus,
  type ShiftKey,
} from "@/lib/respawn";

/**
 * Respawn server fns — the only write path that also touches Monday.
 * submit / review / cancel each do the Supabase write (service role, the
 * source of truth) FIRST, then mirror to Monday best-effort: a Monday hiccup
 * never loses a rep's request or an approver's decision (dojo doctrine). The
 * Supabase row is authoritative; `monday_item_id` is patched back after a
 * successful create.
 */

const submitInput = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shifts: z.array(z.string()).max(14),
  reason: z.string().max(1000).optional(),
});

const reviewInput = z.object({
  id: z.string().uuid(),
  approve: z.boolean(),
  note: z.string().max(1000).optional(),
});

const cancelInput = z.object({ id: z.string().uuid() });

const applyWeekInput = z.object({
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type AdminClient = {
  from: (t: string) => {
    select: (c: string) => { eq: (k: string, v: string) => Promise<{ data: unknown }> };
  };
};

async function assertAdmin(supabase: AdminClient, userId: string): Promise<void> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  if (!roles.includes("owner") && !roles.includes("office_staff")) {
    throw new Error("Only Tyler, Shai or Jorge can review time-off requests.");
  }
}

async function mondayToken(): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("system_settings")
    .select("monday_api_token")
    .maybeSingle();
  return ((data?.monday_api_token as string | null) ?? "").trim();
}

export type SubmitRespawnResult = {
  ok: true;
  status: RespawnStatus;
  late: boolean;
  mondaySynced: boolean;
};

export const submitRespawnRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => submitInput.parse(d))
  .handler(async ({ data, context }): Promise<SubmitRespawnResult> => {
    const userId = context.userId;
    const weekStart = data.weekStart;
    if (!isMondayISO(weekStart)) throw new Error("A week must start on a Monday.");
    const shifts = normalizeShifts(data.shifts);
    if (shifts.length === 0) {
      throw new Error("Pick at least one shift to request off (or withdraw the week instead).");
    }
    const reason = data.reason?.trim() ? data.reason.trim() : null;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: profile, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("display_name, office_location")
      .eq("id", userId)
      .maybeSingle();
    if (profErr) throw new Error(profErr.message);
    const repName = (profile?.display_name as string | null)?.trim() || "Unknown";
    const office: RepOffice = officeToRep(profile?.office_location as string | null);
    const late = isLateForWeek(weekStart);

    const { data: existing } = await supabaseAdmin
      .from("respawn_requests")
      .select("id, monday_item_id")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    const existingItemId = (existing?.monday_item_id as string | null) ?? null;

    // Supabase first (source of truth). Editing resets an approved/denied
    // request back to Pending and clears the decision stamp.
    const { error: upErr } = await supabaseAdmin.from("respawn_requests").upsert(
      {
        user_id: userId,
        rep_name: repName,
        office,
        week_start: weekStart,
        shifts,
        reason,
        status: "pending",
        late,
        decided_by: null,
        decided_at: null,
        decision_note: null,
        monday_item_id: existingItemId,
      },
      { onConflict: "user_id,week_start" },
    );
    if (upErr) throw new Error(upErr.message);

    // Mirror to Monday (best-effort).
    let mondaySynced = false;
    try {
      const token = await mondayToken();
      if (token) {
        const { syncDayOffItem } = await import("@/lib/respawn.server");
        const itemId = await syncDayOffItem(token, {
          repName,
          office,
          weekStart,
          shifts: shifts as ShiftKey[],
          reason,
          status: "pending",
          existingItemId,
        });
        mondaySynced = true;
        if (itemId && itemId !== existingItemId) {
          await supabaseAdmin
            .from("respawn_requests")
            .update({ monday_item_id: itemId })
            .eq("user_id", userId)
            .eq("week_start", weekStart);
        }
      }
    } catch (e) {
      console.error("[respawn] submit Monday sync failed", e);
    }

    return { ok: true, status: "pending", late, mondaySynced };
  });

export const reviewRespawnRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => reviewInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true; attendanceApplied: boolean }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: row, error: rowErr } = await supabaseAdmin
      .from("respawn_requests")
      .select("id, rep_name, office, week_start, shifts, status, monday_item_id")
      .eq("id", data.id)
      .maybeSingle();
    if (rowErr) throw new Error(rowErr.message);
    if (!row) throw new Error("That request no longer exists.");

    const status: RespawnStatus = data.approve ? "approved" : "denied";
    const { error: updErr } = await supabaseAdmin
      .from("respawn_requests")
      .update({
        status,
        decided_by: context.userId,
        decided_at: new Date().toISOString(),
        decision_note: data.note?.trim() ? data.note.trim() : null,
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    // Mirror: flip Approval, and for an APPROVED request whose week is the one
    // the attendance board currently represents (the current LA week), mark
    // the shifts Off now. Approvals for a future week wait for the Sunday-noon
    // apply job (applyApprovedRespawnsForWeek) once that week goes live.
    let attendanceApplied = false;
    try {
      const token = await mondayToken();
      if (token) {
        const { setDayOffApproval, applyAttendance } = await import("@/lib/respawn.server");
        if (row.monday_item_id)
          await setDayOffApproval(token, row.monday_item_id as string, status);
        const isCurrentWeek = (row.week_start as string) === laWeekStartISO(new Date());
        if (data.approve && isCurrentWeek) {
          attendanceApplied = await applyAttendance(token, {
            office: row.office as RepOffice,
            repName: row.rep_name as string,
            shifts: normalizeShifts(row.shifts) as ShiftKey[],
          });
        }
      }
    } catch (e) {
      console.error("[respawn] review Monday sync failed", e);
    }

    return { ok: true, attendanceApplied };
  });

export const cancelRespawnRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("respawn_requests")
      .select("id, user_id, rep_name, office, week_start, shifts, status, monday_item_id")
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: true };

    // Own pending row, or an approver, may withdraw.
    if ((row.user_id as string) !== context.userId) {
      await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    }

    const { error: delErr } = await supabaseAdmin
      .from("respawn_requests")
      .delete()
      .eq("id", data.id);
    if (delErr) throw new Error(delErr.message);

    try {
      const token = await mondayToken();
      if (token) {
        const { deleteDayOffItem, applyAttendance } = await import("@/lib/respawn.server");
        // If an approved current-week request is withdrawn, put the shifts
        // back ON before clearing the Day-Off item.
        const isCurrentWeek = (row.week_start as string) === laWeekStartISO(new Date());
        if ((row.status as string) === "approved" && isCurrentWeek) {
          await applyAttendance(token, {
            office: row.office as RepOffice,
            repName: row.rep_name as string,
            shifts: normalizeShifts(row.shifts) as ShiftKey[],
            label: "On",
          });
        }
        if (row.monday_item_id) await deleteDayOffItem(token, row.monday_item_id as string);
      }
    } catch (e) {
      console.error("[respawn] cancel Monday sync failed", e);
    }

    return { ok: true };
  });

// The Sunday-noon rollover (owner spec #4): apply every APPROVED request for a
// week to the attendance board once that week is the one the board shows.
// Admin-only; also exposed as the "Sync approved → attendance" button so an
// approver can run it on demand for the current week.
export const applyApprovedRespawnsForWeek = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => applyWeekInput.parse(d))
  .handler(async ({ data, context }): Promise<{ applied: number; missing: number }> => {
    await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await supabaseAdmin
      .from("respawn_requests")
      .select("rep_name, office, shifts")
      .eq("status", "approved")
      .eq("week_start", data.weekStart);

    const token = await mondayToken();
    if (!token) throw new Error("No Monday API token configured.");
    const { applyAttendance } = await import("@/lib/respawn.server");

    let applied = 0;
    let missing = 0;
    for (const r of (rows as Array<{
      rep_name: string;
      office: string;
      shifts: string[];
    }> | null) ?? []) {
      const ok = await applyAttendance(token, {
        office: r.office as RepOffice,
        repName: r.rep_name,
        shifts: normalizeShifts(r.shifts) as ShiftKey[],
      });
      if (ok) applied += 1;
      else missing += 1;
    }
    return { applied, missing };
  });
