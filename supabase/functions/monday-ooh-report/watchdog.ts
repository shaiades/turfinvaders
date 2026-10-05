// ═══════════════════════════════════════════════════════════════════════════
// UNCOVERED-LEAD WATCHDOG (Step 7). A scheduled sweep (pg_cron every 5 min, the
// in-code window below keeps it to 7 AM–9 PM PT): if a repless lead starts
// within 60 minutes and nobody is free, iMessage the managers ONCE with the late
// reporters and a suggested rep, and record the alert so it never repeats.
//
// Pure decisions live in dispatch.ts; this is the Deno glue (settings, Monday
// reads, Inkbox, the alert ledger). Inert unless live_dispatch_mode != 'off'.
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import {
  BLOCK_DAY_GROUP,
  hasExistingDisposition,
  isOpenLead,
  laHourMinute,
  laWeekday,
  normName,
} from "./engine.ts";
import { fetchAttendance, fetchDispatchDayItems } from "./monday.ts";
import {
  type DispatchLead,
  type DispatchRep,
  type WatchdogLead,
  findLateReporters,
  inWatchdogWindow,
  isFreeRep,
  nowWallMinutes,
  planWatchdog,
  wallClock12,
} from "./dispatch.ts";
import { sendDispatcherIMessage } from "./inkbox.ts";
import { logDispatchDecision } from "./history.ts";

export type WatchdogSummary = {
  ran: boolean;
  reason?: string;
  alerted: number;
  lateReporters: string[];
};

/** Run the uncovered-lead watchdog for both offices. Safe to call anytime; it
 *  self-gates on live_dispatch_mode and the operating-hours window. */
export async function runWatchdog(supabase: Supa): Promise<WatchdogSummary> {
  const nowMs = Date.now();
  const { hour } = laHourMinute(nowMs);
  if (!inWatchdogWindow(hour))
    return { ran: false, reason: "outside 7am–9pm PT", alerted: 0, lateReporters: [] };

  const { data: settings } = await supabase
    .from("system_settings")
    .select("monday_api_token, active_monday_board_sd, active_monday_board_oc, live_dispatch_mode")
    .maybeSingle();
  const mode = (settings?.live_dispatch_mode as string | null) ?? "off";
  if (mode === "off")
    return { ran: false, reason: "live_dispatch_mode off", alerted: 0, lateReporters: [] };
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return { ran: false, reason: "no Monday token", alerted: 0, lateReporters: [] };

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

  let alerted = 0;
  const allLate: string[] = [];

  for (const { office, boardId } of offices) {
    if (!boardId) continue;
    const [dayItems, attendance] = await Promise.all([
      fetchDispatchDayItems(token, boardId, groupId).catch(() => []),
      fetchAttendance(token, office, weekday).catch(() => new Map()),
    ]);
    if (dayItems.length === 0) continue;

    // Working reps + their open-lead counts → free set.
    const workingReps: DispatchRep[] = [];
    for (const [name, att] of attendance as Map<
      string,
      { amOn: boolean; pmOn: boolean; amOff: boolean; pmOff: boolean }
    >) {
      const working = att.amOn || att.pmOn;
      if (!working) continue;
      const off = att.amOff && att.pmOff && !att.amOn && !att.pmOn;
      const openLeadCount = dayItems.filter(
        (l) =>
          l.reps.map(normName).includes(name) &&
          isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
      ).length;
      workingReps.push({ name, office, working: true, off, openLeadCount, lastCoords: null });
    }
    const freeReps = workingReps.filter(isFreeRep);

    const lateReporters = findLateReporters({
      nowWallMinutes: nowWall,
      leads: dayItems.map((l) => ({
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
      })),
    });
    for (const r of lateReporters) if (!allLate.includes(r)) allLate.push(r);

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

  return { ran: true, alerted, lateReporters: allLate };
}
