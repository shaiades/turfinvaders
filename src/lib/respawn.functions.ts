import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  attendanceWeekStartISO,
  canWithdrawRespawn,
  isLateForWeek,
  isMondayISO,
  normalizeShifts,
  resolveRosterOffice,
  settleApproval,
  shiftsToRevertOnResubmit,
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
  // The granted subset for a partial approval. Omitted/undefined = grant every
  // requested shift (a plain approve). Ignored when approve is false.
  approvedShifts: z.array(z.string()).max(14).optional(),
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

async function userIsAdmin(supabase: AdminClient, userId: string): Promise<boolean> {
  const { data } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  const roles = ((data as Array<{ role: string }> | null) ?? []).map((r) => r.role);
  return roles.includes("owner") || roles.includes("office_staff");
}

async function assertAdmin(supabase: AdminClient, userId: string): Promise<void> {
  if (!(await userIsAdmin(supabase, userId))) {
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
    // Office is the rep's ROSTER office (profiles.office_location) — never a
    // value the rep typed (Sam Corona is OC even if a form said "San Diego").
    const { office, rosterProvided } = resolveRosterOffice(
      profile?.office_location as string | null,
    );
    // Warn when the roster has no office for this rep: we defaulted to SD, and a
    // wrong office writes the day-off to the wrong attendance board (SD vs OC).
    // Surfaces a data fix (set the office in Manage Players / /users).
    if (!rosterProvided) {
      console.warn(
        `[respawn] ${repName} (${userId}) has no roster office_location — defaulting to ${office}. Set their office in Manage Players so approved shifts hit the right attendance board.`,
      );
    }
    const late = isLateForWeek(weekStart);

    const { data: existing } = await supabaseAdmin
      .from("respawn_requests")
      .select("id, monday_item_id, status, approved_shifts, week_start")
      .eq("user_id", userId)
      .eq("week_start", weekStart)
      .maybeSingle();
    const existingItemId = (existing?.monday_item_id as string | null) ?? null;

    // Supabase first (source of truth). Editing resets an approved/denied
    // request back to Pending and clears the decision stamp.
    const { data: saved, error: upErr } = await supabaseAdmin
      .from("respawn_requests")
      .upsert(
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
      )
      .select("id")
      .single();
    if (upErr) throw new Error(upErr.message);
    const rowId = saved.id as string;

    // Mirror to Monday (best-effort).
    let mondaySynced = false;
    try {
      const token = await mondayToken();
      if (token) {
        const { syncDayOffItem, applyAttendance } = await import("@/lib/respawn.server");
        // Editing an already-approved request sends it back to pending — so
        // first UN-apply its attendance writes (set the previously-granted
        // shifts back On) for the current attendance week (#13).
        const revert = shiftsToRevertOnResubmit(
          {
            status: (existing?.status as RespawnStatus | null) ?? "pending",
            approvedShifts: (existing?.approved_shifts as string[] | null) ?? [],
            weekStart: (existing?.week_start as string | null) ?? weekStart,
          },
          attendanceWeekStartISO(new Date()),
        );
        if (revert.length > 0) {
          await applyAttendance(token, { office, repName, shifts: revert, label: "On" });
        }
        const itemId = await syncDayOffItem(token, {
          rowId,
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
  .handler(
    async ({
      data,
      context,
    }): Promise<{ ok: true; status: string; attendanceApplied: boolean }> => {
      await assertAdmin(context.supabase as unknown as AdminClient, context.userId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const { data: row, error: rowErr } = await supabaseAdmin
        .from("respawn_requests")
        .select("id, rep_name, office, week_start, shifts, reason, status, monday_item_id")
        .eq("id", data.id)
        .maybeSingle();
      if (rowErr) throw new Error(rowErr.message);
      if (!row) throw new Error("That request no longer exists.");

      // Resolve the decision: the approver may grant a subset (partial).
      const requested = normalizeShifts(row.shifts) as ShiftKey[];
      const { status, approvedShifts, declinedShifts } = settleApproval(
        requested,
        data.approve ? ((data.approvedShifts ?? null) as ShiftKey[] | null) : [],
        data.approve,
      );

      const { error: updErr } = await supabaseAdmin
        .from("respawn_requests")
        .update({
          status,
          approved_shifts: approvedShifts,
          decided_by: context.userId,
          decided_at: new Date().toISOString(),
          decision_note: data.note?.trim() ? data.note.trim() : null,
        })
        .eq("id", data.id);
      if (updErr) throw new Error(updErr.message);

      // Mirror: write the decision to the Day-Off item, and for a granted
      // request whose week is the one the attendance board currently
      // represents (the current LA week), mark the GRANTED shifts Off now.
      // Grants for a future week wait for applyApprovedRespawnsForWeek.
      let attendanceApplied = false;
      try {
        const token = await mondayToken();
        if (token) {
          const { setDayOffDecision, applyAttendance } = await import("@/lib/respawn.server");
          if (row.monday_item_id) {
            await setDayOffDecision(token, row.monday_item_id as string, {
              status,
              baseReason: (row.reason as string | null) ?? null,
              grantedShifts: approvedShifts,
              declinedShifts,
              note: data.note?.trim() ? data.note.trim() : null,
            });
          }
          // From Sunday noon PT, the coming week is the "current" attendance
          // week — so a weekend approval for next week applies now (#14).
          const isCurrentWeek = (row.week_start as string) === attendanceWeekStartISO(new Date());
          if (approvedShifts.length > 0 && isCurrentWeek) {
            attendanceApplied = await applyAttendance(token, {
              office: row.office as RepOffice,
              repName: row.rep_name as string,
              shifts: approvedShifts,
            });
          }
        }
      } catch (e) {
        console.error("[respawn] review Monday sync failed", e);
      }

      return { ok: true, status, attendanceApplied };
    },
  );

export const cancelRespawnRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cancelInput.parse(d))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row } = await supabaseAdmin
      .from("respawn_requests")
      .select(
        "id, user_id, rep_name, office, week_start, shifts, approved_shifts, status, monday_item_id",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (!row) return { ok: true };

    // A rep may withdraw ONLY their own PENDING request; an approver may
    // withdraw any. An approved/denied request must be edited (→ pending)
    // instead (#13).
    const isOwner = (row.user_id as string) === context.userId;
    const isAdmin = await userIsAdmin(context.supabase as unknown as AdminClient, context.userId);
    if (
      !canWithdrawRespawn({ isOwner, isAdmin, status: (row.status as RespawnStatus) ?? "pending" })
    ) {
      throw new Error(
        isOwner
          ? "Approved or denied requests can't be withdrawn — edit the request to send it back to pending first."
          : "Only the requester or an approver can withdraw this request.",
      );
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
        // If a granted current-week request is withdrawn, put the GRANTED
        // shifts back ON before clearing the Day-Off item.
        const isCurrentWeek = (row.week_start as string) === attendanceWeekStartISO(new Date());
        const wasGranted = ["approved", "partial"].includes(row.status as string);
        const grantedShifts = normalizeShifts(
          (row.approved_shifts as string[] | null) ?? [],
        ) as ShiftKey[];
        if (wasGranted && isCurrentWeek && grantedShifts.length > 0) {
          await applyAttendance(token, {
            office: row.office as RepOffice,
            repName: row.rep_name as string,
            shifts: grantedShifts,
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
      .select("rep_name, office, shifts, approved_shifts, status")
      .in("status", ["approved", "partial"])
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
      approved_shifts: string[] | null;
    }> | null) ?? []) {
      // Granted shifts (approved_shifts); fall back to the full request for any
      // legacy row approved before the partial column existed.
      const granted = normalizeShifts(r.approved_shifts ?? r.shifts) as ShiftKey[];
      if (granted.length === 0) continue;
      const ok = await applyAttendance(token, {
        office: r.office as RepOffice,
        repName: r.rep_name,
        shifts: granted,
      });
      if (ok) applied += 1;
      else missing += 1;
    }
    return { applied, missing };
  });
