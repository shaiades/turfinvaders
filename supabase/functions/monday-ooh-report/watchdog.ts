// ═══════════════════════════════════════════════════════════════════════════
// UNCOVERED-LEAD WATCHDOG (Step 7). A scheduled sweep (pg_cron every 5 min, the
// in-code window below keeps it to 7 AM–9 PM PT): if a repless lead starts
// within 60 minutes and nobody is free, iMessage the managers ONCE with the late
// reporters and a suggested rep, and record the alert so it never repeats.
//
// Rule 6 (owner mandate 2026-10-08): if no free rep can get there on time, still
// SEND the closest working rep — people6 ADDITIVE (Rule 1), Iss pressed, a
// "running ~X min late, office please call customer" note on the card, and a
// managers text. Never over a lead a human touched today (Rule 3); Daniel is
// never sent alone (Rule 8); every people6/Iss write is audited (Rule 21).
//
// Pure decisions live in dispatch.ts; this is the Deno glue (settings, Monday
// reads/writes, Inkbox, the alert ledger). Inert unless live_dispatch_mode != 'off'.
// ═══════════════════════════════════════════════════════════════════════════
import type { Supa } from "./supa.ts";
import {
  BLOCK_COL,
  BLOCK_DAY_GROUP,
  GUARDED_WRITE_COLS,
  LABEL,
  hasExistingDisposition,
  humanTouchedGuardedColsToday,
  isOpenLead,
  laDate,
  laHourMinute,
  laWeekday,
} from "./engine.ts";
import {
  fetchAttendance,
  fetchBlockItem,
  fetchDispatchDayItems,
  fetchItemActivity,
  fetchMondayMe,
  fetchMondayUsers,
  fetchPeopleColumnIds,
  resolveUserId,
  resolveUserIdByFirstName,
  setColumns,
  setPeopleColumn,
  setStatus,
} from "./monday.ts";
import {
  type DispatchLead,
  type DispatchPairingOverride,
  type DispatchRep,
  type WatchdogLead,
  buildRunningLateText,
  choosePartner,
  findLateReporters,
  firstName,
  inWatchdogWindow,
  isFreeRep,
  mergePeople,
  mustPair,
  nowWallMinutes,
  planLateCoverage,
  planWatchdog,
  runningLateNote,
  sameRep,
  wallClock12,
  withPairing,
} from "./dispatch.ts";
import { sendDispatcherIMessage } from "./inkbox.ts";
import { logDispatchDecision, logDispatchWrite } from "./history.ts";

export type WatchdogSummary = {
  ran: boolean;
  reason?: string;
  alerted: number;
  lateReporters: string[];
  /** Uncovered leads covered late by the closest rep (Rule 6). */
  lateCovered?: number;
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
    .select(
      "monday_api_token, active_monday_board_sd, active_monday_board_oc, live_dispatch_mode, dispatch_pairing",
    )
    .maybeSingle();
  const mode = (settings?.live_dispatch_mode as string | null) ?? "off";
  if (mode === "off")
    return { ran: false, reason: "live_dispatch_mode off", alerted: 0, lateReporters: [] };
  const token = ((settings?.monday_api_token as string | null) ?? "").trim();
  if (!token) return { ran: false, reason: "no Monday token", alerted: 0, lateReporters: [] };
  const cfg = withPairing((settings?.dispatch_pairing as DispatchPairingOverride | null) ?? null);

  const offices: Array<{ office: "SD" | "OC"; boardId: string | null }> = [
    { office: "SD", boardId: (settings?.active_monday_board_sd as string | null) ?? null },
    { office: "OC", boardId: (settings?.active_monday_board_oc as string | null) ?? null },
  ];

  const weekday = laWeekday(nowMs);
  const groupId = BLOCK_DAY_GROUP[weekday];
  const nowWall = nowWallMinutes(nowMs);
  const todayLA = laDate(nowMs);

  // Only resolve Monday users + the dispatcher id when we may actually write.
  const live = mode === "live";
  const [users, dispatcherUserId] = live
    ? await Promise.all([
        fetchMondayUsers(token).catch(() => [] as Array<{ id: string; name: string }>),
        fetchMondayMe(token).catch(() => null),
      ])
    : [[] as Array<{ id: string; name: string }>, null];

  // Leads already alerted (so we never repeat).
  const { data: alertedRows } = await supabase.from("ooh_uncovered_alerts").select("lead_item_id");
  const alreadyAlerted = new Set(
    ((alertedRows as Array<{ lead_item_id: string }> | null) ?? []).map((r) => r.lead_item_id),
  );

  let alerted = 0;
  let lateCovered = 0;
  const allLate: string[] = [];

  for (const { office, boardId } of offices) {
    if (!boardId) continue;
    const [dayItems, attendance] = await Promise.all([
      fetchDispatchDayItems(token, boardId, groupId).catch(() => []),
      fetchAttendance(token, office, weekday).catch(() => new Map()),
    ]);
    if (dayItems.length === 0) continue;

    // Working reps + their open-lead counts → free set. Attendance is keyed by
    // FIRST NAME (the boards label rows loosely), so match day-item reps —
    // which carry full people6 names — by first name too.
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
          l.reps.some((r) => sameRep(r, name)) &&
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
      cfg,
    });

    for (const a of result.alerts) {
      // Claim the alert first so a concurrent run can't double-send.
      const { error } = await supabase
        .from("ooh_uncovered_alerts")
        .insert({ lead_item_id: a.lead.itemId, office, board_id: boardId });
      if (error) continue; // already alerted (unique violation) → skip
      alreadyAlerted.add(a.lead.itemId);

      // ── Rule 6: send the closest working rep, even if late ────────────────
      const dl = byId.get(a.lead.itemId);
      const covered =
        live && dl
          ? await coverLate({
              supabase,
              token,
              users,
              dispatcherUserId,
              office,
              boardId,
              lead: dl,
              workingReps,
              freeReps,
              nowWall,
              nowMs,
              todayLA,
              cfg,
            }).catch(() => null)
          : null;

      if (covered && covered.covered) {
        lateCovered += 1;
        await logDispatchDecision(supabase, {
          mode: "live",
          trigger: "watchdog",
          formItemId: null,
          repName: covered.repName,
          office,
          boardId,
          leadItemId: a.lead.itemId,
          leadName: a.lead.name,
          action: "issue",
          score: null,
          driveMinutes: covered.driveMinutes,
          strength: null,
          reason: `late cover: ${covered.reason}`,
          issued: true,
        });
      } else {
        // Nobody could be sent (or dry-run / blocked) → the original alert text.
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
      }
      alerted += 1;
    }
  }

  return { ran: true, alerted, lateReporters: allLate, lateCovered };
}

/**
 * Rule 6 live late-cover: send the closest working rep to an uncovered lead,
 * ADDING them to people6 (Rule 1), pressing Iss, appending the running-late
 * note to Details, and texting the managers. Honors Rule 3 (never over a
 * human's same-day change) and Rule 8 (Daniel never alone). Every people6/Iss
 * write is audited (Rule 21). Returns {covered:false} when nothing was written.
 */
async function coverLate(p: {
  supabase: Supa;
  token: string;
  users: Array<{ id: string; name: string }>;
  dispatcherUserId: string | null;
  office: "SD" | "OC";
  boardId: string;
  lead: DispatchLead;
  workingReps: DispatchRep[];
  freeReps: DispatchRep[];
  nowWall: number;
  nowMs: number;
  todayLA: string;
  cfg: typeof import("./dispatch.ts").DISPATCH_CONFIG;
}): Promise<{
  covered: boolean;
  repName: string | null;
  driveMinutes: number | null;
  reason: string;
}> {
  const plan = planLateCoverage({
    lead: p.lead,
    workingReps: p.workingReps,
    nowWallMinutes: p.nowWall,
    cfg: p.cfg,
  });
  if (plan.action !== "assign-late")
    return { covered: false, repName: null, driveMinutes: null, reason: plan.reason };

  // Rule 3: never write over a lead a human touched today.
  try {
    const logs = await fetchItemActivity(
      p.token,
      p.boardId,
      p.lead.itemId,
      new Date(p.nowMs - 86_400_000).toISOString(),
      new Date(p.nowMs).toISOString(),
    );
    if (
      humanTouchedGuardedColsToday({
        logs,
        dispatcherUserId: p.dispatcherUserId,
        todayLA: p.todayLA,
        guardedColumnIds: GUARDED_WRITE_COLS,
      })
    )
      return { covered: false, repName: null, driveMinutes: null, reason: "human touched today" };
  } catch {
    /* best-effort — a log-read failure never blocks (Rule 1 keeps any rep) */
  }

  const uid =
    resolveUserId(p.users, plan.rep.name) ?? resolveUserIdByFirstName(p.users, plan.rep.name);
  if (!uid)
    return {
      covered: false,
      repName: plan.rep.name,
      driveMinutes: plan.driveMinutes,
      reason: "no Monday user",
    };

  // Rule 8: Daniel never alone — add a partner when the closest rep can't solo.
  let partnerUid: string | null = null;
  if (mustPair(plan.rep.name, p.cfg) && p.lead.reps.length === 0) {
    const partner = choosePartner({
      rep: plan.rep,
      lead: p.lead,
      freeReps: p.freeReps.filter((fr) => firstName(fr.name) !== firstName(plan.rep.name)),
      cfg: p.cfg,
    });
    if (!partner)
      return {
        covered: false,
        repName: plan.rep.name,
        driveMinutes: plan.driveMinutes,
        reason: "can't run solo, no partner free (Rule 8)",
      };
    partnerUid =
      resolveUserId(p.users, partner.name) ?? resolveUserIdByFirstName(p.users, partner.name);
  }

  // Rule 1: union existing people6 with the late rep (+ partner) — never remove.
  const existingIds = await fetchPeopleColumnIds(p.token, p.lead.itemId, BLOCK_COL.reps).catch(
    () => [] as string[],
  );
  const merged = mergePeople(existingIds, [uid, ...(partnerUid ? [partnerUid] : [])]);

  // Append the running-late note to Details (read current, never overwrite).
  const current = await fetchBlockItem(p.token, p.lead.itemId).catch(() => null);
  const note = runningLateNote(plan.lateMinutes);
  const combined = current?.details?.trim() ? `${current.details.trim()}\n${note}` : note;
  await setColumns(
    p.token,
    p.boardId,
    p.lead.itemId,
    { [BLOCK_COL.details]: { text: combined } },
    `ooh-latecover-note-${p.lead.itemId}`,
  ).catch(() => undefined);

  const r1 = await setPeopleColumn(
    p.token,
    p.boardId,
    p.lead.itemId,
    BLOCK_COL.reps,
    merged,
    `ooh-latecover-people-${p.lead.itemId}`,
  );
  if (r1.error)
    return {
      covered: false,
      repName: plan.rep.name,
      driveMinutes: plan.driveMinutes,
      reason: r1.error,
    };
  await logDispatchWrite(p.supabase, {
    mode: "live",
    trigger: "late_cover",
    formItemId: null,
    boardId: p.boardId,
    itemId: p.lead.itemId,
    leadName: p.lead.name,
    columnId: BLOCK_COL.reps,
    columnLabel: "Reps",
    oldValue: existingIds.join(","),
    newValue: merged.join(","),
    reason: plan.reason,
  });
  const r2 = await setStatus(
    p.token,
    p.boardId,
    p.lead.itemId,
    BLOCK_COL.iss,
    LABEL.iss,
    `ooh-latecover-iss-${p.lead.itemId}`,
  );
  if (r2.error)
    return {
      covered: false,
      repName: plan.rep.name,
      driveMinutes: plan.driveMinutes,
      reason: r2.error,
    };
  await logDispatchWrite(p.supabase, {
    mode: "live",
    trigger: "late_cover",
    formItemId: null,
    boardId: p.boardId,
    itemId: p.lead.itemId,
    leadName: p.lead.name,
    columnId: BLOCK_COL.iss,
    columnLabel: "Iss",
    oldValue: p.lead.issLabel ?? null,
    newValue: LABEL.iss,
    reason: plan.reason,
  });

  // Rule 6 text: running late, office please call the customer.
  await sendDispatcherIMessage(
    buildRunningLateText({
      office: p.office,
      leadName: p.lead.name,
      repName: plan.rep.name,
      lateMinutes: plan.lateMinutes,
      apptClock: wallClock12(p.lead.apptWallMinutes),
    }),
  ).catch(() => undefined);

  return {
    covered: true,
    repName: plan.rep.name,
    driveMinutes: plan.driveMinutes,
    reason: plan.reason,
  };
}
