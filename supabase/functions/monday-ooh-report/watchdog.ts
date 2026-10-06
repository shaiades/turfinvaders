// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULED SWEEP (Step 7; pg_cron every 5 min, in-code window 7 AM–9 PM PT):
//   1. UNCOVERED-LEAD watchdog — a repless lead starting within 60 minutes with
//      nobody free → iMessage the managers ONCE (late reporters + a suggested
//      rep), ledgered in ooh_uncovered_alerts.
//   2. MISSING-REPORT watchdog (owner 10/6) — an issued lead 3+ hours past its
//      start with no report → iMessage the managers ONCE, ledgered in
//      ooh_missing_report_alerts.
//   3. SALES PROCESSING follow-up drain — fill Deposit/Finance/Advantage+/
//      Reloads once a Sold item lands on board 4155553389 (salesproc.ts).
//
// Pure decisions live in dispatch.ts; this is the Deno glue (settings, Monday
// reads, Inkbox, the alert ledgers). 1+2 are inert unless live_dispatch_mode
// != 'off'; 3 runs whenever the write-back itself is live.
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import {
  BLOCK_DAY_GROUP,
  hasExistingDisposition,
  isOpenLead,
  laDate,
  laHourMinute,
  laWeekday,
} from "./engine.ts";
import { fetchAttendance, fetchDispatchDayItems } from "./monday.ts";
import {
  type DispatchLead,
  type DispatchRep,
  type WatchdogLead,
  attendanceWithOverride,
  buildMissingReportText,
  findLateReporters,
  firstName,
  inWatchdogWindow,
  isFreeRep,
  nowWallMinutes,
  planMissingReports,
  planWatchdog,
  sameRep,
  wallClock12,
} from "./dispatch.ts";
import { sendDispatcherIMessage } from "./inkbox.ts";
import { logDispatchDecision } from "./history.ts";
import { processSalesProcFollowups, type SalesProcSummary } from "./salesproc.ts";

export type WatchdogSummary = {
  ran: boolean;
  reason?: string;
  alerted: number;
  missingReportAlerts: number;
  lateReporters: string[];
  salesProc?: SalesProcSummary;
};

/** Today's manager attendance overrides for one office → Map(firstName → on|off).
 *  Overrides BEAT the attendance board (owner 10/6 — the board is sometimes
 *  wrong). Shared with index.ts. */
export async function fetchAttendanceOverrides(
  supabase: Supa,
  office: "SD" | "OC",
  nowMs: number,
): Promise<Map<string, "on" | "off">> {
  const out = new Map<string, "on" | "off">();
  try {
    const { data } = await supabase
      .from("attendance_overrides")
      .select("rep_name, status")
      .eq("office", office)
      .eq("for_date", laDate(nowMs));
    for (const row of (data as Array<{ rep_name: string; status: string }> | null) ?? []) {
      const key = firstName(row.rep_name);
      if (key && (row.status === "on" || row.status === "off")) out.set(key, row.status);
    }
  } catch {
    /* best-effort — fall back to the board */
  }
  return out;
}

/** Run the scheduled sweep for both offices. Safe to call anytime; it
 *  self-gates on the modes and the operating-hours window. */
export async function runWatchdog(supabase: Supa): Promise<WatchdogSummary> {
  const nowMs = Date.now();
  const { hour } = laHourMinute(nowMs);
  const base: WatchdogSummary = {
    ran: false,
    alerted: 0,
    missingReportAlerts: 0,
    lateReporters: [],
  };
  if (!inWatchdogWindow(hour)) return { ...base, reason: "outside 7am–9pm PT" };

  const { data: settings } = await supabase
    .from("system_settings")
    .select(
      "monday_api_token, active_monday_board_sd, active_monday_board_oc, live_dispatch_mode, ooh_writeback_mode",
    )
    .maybeSingle();
  const mode = (settings?.live_dispatch_mode as string | null) ?? "off";
  const writebackMode = (settings?.ooh_writeback_mode as string | null) ?? "off";
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return { ...base, reason: "no Monday token" };

  // 3. Sales Processing follow-ups ride the write-back switch, not dispatch.
  let salesProc: SalesProcSummary | undefined;
  if (writebackMode === "live") {
    salesProc = await processSalesProcFollowups(supabase, token).catch(() => undefined);
  }

  if (mode === "off")
    return { ...base, ran: writebackMode === "live", reason: "live_dispatch_mode off", salesProc };

  const offices: Array<{ office: "SD" | "OC"; boardId: string | null }> = [
    { office: "SD", boardId: (settings?.active_monday_board_sd as string | null) ?? null },
    { office: "OC", boardId: (settings?.active_monday_board_oc as string | null) ?? null },
  ];

  const weekday = laWeekday(nowMs);
  const groupId = BLOCK_DAY_GROUP[weekday];
  const nowWall = nowWallMinutes(nowMs);

  // Leads already alerted (so we never repeat).
  const { data: alertedRows } = await supabase.from("ooh_uncovered_alerts").select("lead_item_id");
  const alreadyAlerted = new Set(
    ((alertedRows as Array<{ lead_item_id: string }> | null) ?? []).map((r) => r.lead_item_id),
  );
  const { data: missingRows } = await supabase
    .from("ooh_missing_report_alerts")
    .select("lead_item_id");
  const missingAlerted = new Set(
    ((missingRows as Array<{ lead_item_id: string }> | null) ?? []).map((r) => r.lead_item_id),
  );

  let alerted = 0;
  let missingReportAlerts = 0;
  const allLate: string[] = [];

  for (const { office, boardId } of offices) {
    if (!boardId) continue;
    const [dayItems, attendance, overrides] = await Promise.all([
      fetchDispatchDayItems(token, boardId, groupId).catch(() => []),
      fetchAttendance(token, office, weekday).catch(() => new Map()),
      fetchAttendanceOverrides(supabase, office, nowMs),
    ]);
    if (dayItems.length === 0) continue;

    // Working reps + their open-lead counts → free set. Attendance is keyed by
    // FIRST NAME (the boards label rows loosely), so match day-item reps —
    // which carry full people6 names — by first name too. A manager override
    // (attendance_overrides) beats the board either way.
    const workingReps: DispatchRep[] = [];
    const seen = new Set<string>();
    for (const [name, att] of attendance as Map<
      string,
      { amOn: boolean; pmOn: boolean; amOff: boolean; pmOff: boolean }
    >) {
      seen.add(name);
      const boardState = {
        working: att.amOn || att.pmOn,
        off: att.amOff && att.pmOff && !att.amOn && !att.pmOn,
      };
      const state = attendanceWithOverride(boardState, overrides.get(name) ?? null);
      if (!state.working) continue;
      const openLeadCount = dayItems.filter(
        (l) =>
          l.reps.some((r) => sameRep(r, name)) &&
          isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
      ).length;
      workingReps.push({
        name,
        office,
        working: true,
        off: state.off,
        openLeadCount,
        lastCoords: null,
      });
    }
    // An override can turn ON a rep the board doesn't even list.
    for (const [name, status] of overrides) {
      if (status !== "on" || seen.has(name)) continue;
      const openLeadCount = dayItems.filter(
        (l) =>
          l.reps.some((r) => sameRep(r, name)) &&
          isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
      ).length;
      workingReps.push({
        name,
        office,
        working: true,
        off: false,
        openLeadCount,
        lastCoords: null,
      });
    }
    const freeReps = workingReps.filter(isFreeRep);

    const leadsWithDispo = dayItems.map((l) => ({
      itemId: l.itemId,
      name: l.name,
      reps: l.reps,
      issLabel: l.issLabel,
      apptWallMinutes: l.apptWallMinutes,
      disposition: hasExistingDisposition({
        pm: l.pm,
        rs: l.rs,
        ol: l.ol,
        bo: l.bo,
        sale: l.sale,
      }),
    }));

    const lateReporters = findLateReporters({ nowWallMinutes: nowWall, leads: leadsWithDispo });
    for (const r of lateReporters) if (!allLate.includes(r)) allLate.push(r);

    // ── 2. Missing-report alert (3+ hours past start, once, one text) ────────
    const missing = planMissingReports({
      nowWallMinutes: nowWall,
      leads: leadsWithDispo,
      alreadyAlerted: missingAlerted,
    });
    if (missing.length > 0) {
      const claimed: typeof missing = [];
      for (const m of missing) {
        // Claim first so a concurrent run can't double-send.
        const { error } = await supabase
          .from("ooh_missing_report_alerts")
          .insert({ lead_item_id: m.itemId, office, board_id: boardId });
        if (!error) {
          claimed.push(m);
          missingAlerted.add(m.itemId);
        }
      }
      if (claimed.length > 0) {
        await sendDispatcherIMessage(buildMissingReportText(claimed)).catch(() => undefined);
        missingReportAlerts += claimed.length;
        for (const m of claimed) {
          await logDispatchDecision(supabase, {
            mode: mode === "live" ? "live" : "dry_run",
            trigger: "watchdog",
            formItemId: null,
            repName: m.reps[0] ?? null,
            office,
            boardId,
            leadItemId: m.itemId,
            leadName: m.name,
            action: "alert",
            score: null,
            driveMinutes: null,
            strength: null,
            reason: `no report ${Math.floor((nowWall - (m.apptWallMinutes ?? nowWall)) / 60)}h after start`,
            issued: false,
          });
        }
      }
    }

    // ── 1. Uncovered-lead alert ──────────────────────────────────────────────
    const watchdogLeads: WatchdogLead[] = dayItems.map((l) => ({
      itemId: l.itemId,
      name: l.name,
      apptWallMinutes: l.apptWallMinutes,
      reps: l.reps,
      issLabel: l.issLabel,
    }));
    const byId = new Map<string, DispatchLead>(dayItems.map((l) => [l.itemId, l]));

    const result = planWatchdog({
      nowWallMinutes: nowWall,
      leads: watchdogLeads,
      freeReps,
      lateReporters,
      workingReps,
      alreadyAlerted,
      dispatchLeadsById: byId,
    });

    for (const a of result.alerts) {
      // Claim the alert first so a concurrent run can't double-send.
      const { error } = await supabase
        .from("ooh_uncovered_alerts")
        .insert({ lead_item_id: a.lead.itemId, office, board_id: boardId });
      if (error) continue; // already alerted (unique violation) → skip
      alreadyAlerted.add(a.lead.itemId);
      const when = wallClock12(a.lead.apptWallMinutes);
      const suggested = a.suggestedRep ? ` Suggested rep: ${a.suggestedRep}.` : "";
      const late = lateReporters.length ? ` Late reporters: ${lateReporters.join(", ")}.` : "";
      await sendDispatcherIMessage(
        `⚠️ Uncovered lead (${office}): ${a.lead.name} at ${when} — nobody free.${suggested}${late}`,
      ).catch(() => undefined);
      await logDispatchDecision(supabase, {
        mode: mode === "live" ? "live" : "dry_run",
        trigger: "watchdog",
        formItemId: null,
        repName: a.suggestedRep,
        office,
        boardId,
        leadItemId: a.lead.itemId,
        leadName: a.lead.name,
        action: "alert",
        score: null,
        driveMinutes: null,
        strength: null,
        reason: a.reason,
        issued: false,
      });
      alerted += 1;
    }
  }

  return { ran: true, alerted, missingReportAlerts, lateReporters: allLate, salesProc };
}
