// ═══════════════════════════════════════════════════════════════════════════
// OUT OF HOUSE (OOH) write-back receiver. Monday fires "When an item is created"
// on board 18433859050 ("Out of House Reports"); this writes the disposition
// onto the lead's BLOCK item (the pure engine decides what), then lets the
// block's own automations route it. Modeled on monday-live-dispatch.
//
// SAFETY: writes to live Monday only when system_settings.ooh_writeback_mode =
// 'live' AND the target block board is allowed (allowlist, else the current
// SD/OC blocks). Default 'off' → acknowledge and do nothing. 'dry_run' → store
// the computed plan in ooh_report_queue, write nothing. Never routes anything
// itself; never touches destination boards.
// ═══════════════════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { makeClient, type Supa } from "./supa.ts";
import {
  type BlockItem,
  fetchAttendance,
  fetchBlockItem,
  fetchDispatchDayItems,
  fetchFormItem,
  fetchMondayUsers,
  postUpdate,
  resolveUserId,
  setColumns,
  setPeopleColumn,
  setStatus,
} from "./monday.ts";
import { sendDispatcherIMessage, type InkboxResult } from "./inkbox.ts";
import {
  BLOCK_COL,
  DISPATCHER_LABEL,
  FORM_BOARD_ID,
  OOH_DISPATCHER_COL,
  buildBaseQueueRow,
  buildDetailsLine,
  buildSaleAlert,
  hasExistingDisposition,
  isAllowedOohBoard,
  isOpenLead,
  isSaleResult,
  LABEL,
  laClock,
  laWeekday,
  matchTarget,
  normName,
  oohUpdateKey,
  parseOohForm,
  planDisposition,
  sourceCodeToWrite,
} from "./engine.ts";
import {
  type DispatchRep,
  buildFreeRepsLine,
  buildIssuedText,
  firstName,
  nowWallMinutes,
  planIssue,
} from "./dispatch.ts";
import { runWatchdog } from "./watchdog.ts";
import { enrichHistory, logDispatchDecision } from "./history.ts";

const denoEnv = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno
  ?.env;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-monday-secret",
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // ── Uncovered-lead watchdog (scheduled, every 5 min 7 AM–9 PM PT) ───────────
  // Rides the same function at ?task=watchdog so it can reuse the dispatch
  // engine without duplicating it across edge functions. Authenticated by the
  // shared notify secret (the pg_cron job posts it); the full flow lives in
  // watchdog.ts and is a no-op unless live_dispatch_mode != 'off'.
  const url = new URL(req.url);
  if (url.searchParams.get("task") === "watchdog") {
    const notifySecret = denoEnv?.get("NOTIFY_SECRET");
    const provided = req.headers.get("x-notify-secret") ?? url.searchParams.get("secret");
    if (notifySecret && provided !== notifySecret) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const SUPABASE_URL = denoEnv?.get("SUPABASE_URL") ?? "";
    const SERVICE_ROLE = denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = makeClient(SUPABASE_URL, SERVICE_ROLE);
    try {
      const result = await runWatchdog(supabase);
      return ok(result);
    } catch (e) {
      console.error("[ooh watchdog] error", e instanceof Error ? e.message : String(e));
      return ok({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  const raw = await req.text();
  if (!raw) return ok({ ignored: "empty body" });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return ok({ ignored: "non-JSON body" });
  }

  // Monday webhook challenge handshake.
  if (body.challenge) {
    return new Response(JSON.stringify({ challenge: body.challenge }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Secret gate. Prefer a dedicated MONDAY_OOH_SECRET so this webhook is
  // independent of the shared live-dispatch secret; fall back to the shared one.
  const secret = denoEnv?.get("MONDAY_OOH_SECRET") ?? denoEnv?.get("MONDAY_WEBHOOK_SECRET");
  if (secret) {
    const url = new URL(req.url);
    const provided = req.headers.get("x-monday-secret") ?? url.searchParams.get("secret");
    if (provided !== secret) {
      const enforce =
        denoEnv?.get("MONDAY_OOH_ENFORCE_SECRET") === "true" ||
        denoEnv?.get("MONDAY_WEBHOOK_ENFORCE_SECRET") === "true";
      console.warn("[ooh] webhook secret mismatch", { enforce });
      if (enforce) return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
  }

  const event = (body.data as Record<string, unknown>)?.event
    ? ((body.data as Record<string, unknown>).event as Record<string, unknown>)
    : ((body.event as Record<string, unknown>) ?? body);
  const formItemId = String(event.pulseId ?? event.itemId ?? event.pulse_id ?? "");
  const triggerUuid = String(
    (body.data as Record<string, unknown>)?.triggerUuid ??
      event.triggerUuid ??
      event.originalTriggerUuid ??
      "",
  );
  if (!formItemId || !/^\d+$/.test(formItemId)) return ok({ ignored: "no form item id" });

  // Only accept events from the OOH form board — ignore anything else so a
  // mis-wired webhook on another board can never drive a disposition.
  const eventBoardId = event.boardId ?? event.board_id ?? null;
  if (!isAllowedOohBoard(eventBoardId as string | number | null)) {
    return ok({ ignored: "wrong board", boardId: String(eventBoardId) });
  }

  const SUPABASE_URL = denoEnv?.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = makeClient(SUPABASE_URL, SERVICE_ROLE);

  // ── idempotency CLAIM: once-only even under concurrent redelivery ──────────
  // Insert a 'processing' claim; a conflict means another delivery owns it (or
  // it's done) → skip. On a pre-write failure we delete the claim so Monday can
  // retry; once Monday has been touched we KEEP the claim so a retry never
  // presses a button or appends Details twice.
  const { error: claimErr } = await supabase
    .from("ooh_processed_reports")
    .insert({ form_item_id: formItemId, trigger_uuid: triggerUuid, outcome: "processing" });
  if (claimErr) {
    // 23505 = unique_violation → already claimed/processed.
    return ok({ deduped: true, formItemId });
  }

  let mondayTouched = false;
  // Set once settings are read, so the Dispatcher-column stamp (below) and the
  // live-dispatch flow can reach Monday. null until then → stamping is a no-op.
  let oohToken: string | null = null;
  const releaseClaimForRetry = async () => {
    if (!mondayTouched)
      await supabase.from("ooh_processed_reports").delete().eq("form_item_id", formItemId);
  };
  const finish = async (outcome: string, extra: Record<string, unknown> = {}) => {
    await supabase
      .from("ooh_processed_reports")
      .update({ outcome, ...extra })
      .eq("form_item_id", formItemId);
  };
  // Stamp the OOH board's "Dispatcher" status column with the human-facing
  // outcome (Processed / Needs review / Error) so the office sees it at a glance
  // (owner brief, Part 1 "Afterwards"). Best-effort; never blocks the write.
  const stampDispatcher = async (label: string) => {
    if (!oohToken) return;
    await setStatus(
      oohToken,
      FORM_BOARD_ID,
      formItemId,
      OOH_DISPATCHER_COL,
      label,
      `ooh-disp-${formItemId}-${label}`,
    ).catch(() => undefined);
  };
  const queue = async (status: string, reason: string, row: Record<string, unknown>) => {
    await supabase
      .from("ooh_report_queue")
      .upsert({ form_item_id: formItemId, status, reason, ...row }, { onConflict: "form_item_id" });
    // Mirror the outcome onto the Dispatcher column: a clean dry-run preview is
    // "Processed" (would auto-handle), anything a human must touch is "Needs
    // review", a failure is "Error".
    await stampDispatcher(
      status === "error"
        ? DISPATCHER_LABEL.error
        : status === "dry_run"
          ? DISPATCHER_LABEL.processed
          : DISPATCHER_LABEL.needsReview,
    );
    // Text the office ONLY for genuine failures (errors). Routine "needs
    // review" items (e.g. an on-block report with no Lead ID the office must
    // file by hand) are visible in the Dispo tab and no longer buzz the
    // dispatcher's phone — that notification was too noisy. Best-effort.
    if (status === "error") {
      await sendDispatcherIMessage(
        `Dispo write-back error: ${String(row.rep_name ?? "?")}, result ${String(row.result ?? "?")}. Open Close Kombat → Dispo.`,
      ).catch(() => undefined);
    }
  };

  // Hoisted so the catch-all error row still carries rep + lead detail (never a
  // bare form id). Filled in once the form is parsed.
  let baseRow: Record<string, unknown> = {};

  try {
    // ── settings ──────────────────────────────────────────────────────────
    const { data: settings } = await supabase
      .from("system_settings")
      .select(
        "monday_api_token, active_monday_board_sd, active_monday_board_oc, ooh_writeback_mode, ooh_writeback_board_allowlist, ooh_autocreate, live_dispatch_mode",
      )
      .maybeSingle();
    const token = ((settings?.monday_api_token as string | null) ?? "").trim();
    oohToken = token || null;
    const mode = (settings?.ooh_writeback_mode as string | null) ?? "off";
    const dispatchMode = ((settings?.live_dispatch_mode as string | null) ?? "off") as
      "off" | "dry_run" | "live";
    const activeSd = (settings?.active_monday_board_sd as string | null) ?? null;
    const activeOc = (settings?.active_monday_board_oc as string | null) ?? null;
    const allowlist = ((settings?.ooh_writeback_board_allowlist as string | null) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const allowedBoards = new Set(
      allowlist.length ? allowlist : ([activeSd, activeOc].filter(Boolean) as string[]),
    );

    if (mode === "off") {
      // Truly inert: acknowledge, read/write nothing, keep the claim.
      await finish("off");
      return ok({ mode: "off", formItemId });
    }
    if (!token) {
      await finish("error", {});
      await queue("error", "no Monday API token configured", { form_item_id: formItemId });
      return ok({ error: "no token" });
    }

    // ── fetch + parse the form submission ───────────────────────────────────
    const formItem = await fetchFormItem(token, formItemId);
    if (!formItem) {
      await releaseClaimForRetry();
      return ok({ error: "form item not found (will retry)" });
    }
    const form = parseOohForm(formItemId, formItem.cols);
    const plan = planDisposition(form);
    const target = matchTarget(form);
    // Preliminary Details (no appointment fallback — used by the queue paths
    // that have no block). The write path rebuilds it once the block is known,
    // so a blank arrival can fall back to the appointment time (Rule 3 / #6).
    const detailsLine = buildDetailsLine(form, formItem.createdAtMs);
    const formLink = `https://tidal-remodeling.monday.com/boards/${FORM_BOARD_ID}/pulses/${formItemId}`;
    baseRow = buildBaseQueueRow(form, detailsLine, plan);

    // A plan the engine refuses to auto-apply (e.g. a reset result with no
    // reset date) goes to the office — press nothing (#4).
    if (plan.needsReview) {
      await finish("queued");
      await queue("needs_review", plan.needsReview, baseRow);
      return ok({ queued: plan.needsReview });
    }

    // A self-gen / off-block SALE still texts leadership immediately, even
    // though its card is queued for the office (a rep who sold on their own
    // shouldn't wait on card-creation for the SALE to land). Only in live mode;
    // never in dry_run. Best-effort — the send never throws.
    const saleAlertSent = { done: false };
    const alertSaleOnce = async (customer: string | null): Promise<InkboxResult | null> => {
      if (saleAlertSent.done || mode !== "live" || !isSaleResult(form)) return null;
      saleAlertSent.done = true;
      try {
        return await sendDispatcherIMessage(buildSaleAlert(form, customer));
      } catch (e) {
        return { sent: false, attempted: 0, delivered: 0, errors: [String(e)] };
      }
    };
    // A genuine send failure (not just "not configured") → a short note so the
    // office can see leadership wasn't texted. Never a reason to fail the write.
    const saleTextError = (r: InkboxResult | null): string | null =>
      r && !r.sent && !r.skipped && r.errors?.length
        ? `SALE written but leadership text failed: ${r.errors.join("; ").slice(0, 280)}`
        : null;

    // Only the matched-lead path writes automatically. Create (self-gen /
    // upsell / reload) is queued unless auto-create is explicitly enabled.
    if (target.kind !== "write") {
      const autocreate = (settings?.ooh_autocreate as boolean | null) ?? false;
      if (target.kind === "create" && !autocreate) {
        await finish("queued");
        const saleRes = await alertSaleOnce(formItem.name || form.address); // self-gen SALE → text now
        const ste = saleTextError(saleRes);
        await queue("needs_review", `auto-create off — ${target.reason}`, {
          ...baseRow,
          ...(ste ? { error: ste } : {}),
        });
        return ok({ queued: "create (auto-create off)" });
      }
      if (target.kind === "queue") {
        await finish("queued");
        await queue("needs_review", target.reason, baseRow);
        return ok({ queued: target.reason });
      }
    }

    // ── matched lead: resolve + gate ────────────────────────────────────────
    const leadId = (target as { leadId?: string }).leadId ?? form.leadId!;
    const block = await fetchBlockItem(token, leadId);
    if (!block || block.state !== "active") {
      await finish("queued");
      await queue("needs_review", "Lead ID not found or inactive on any block", {
        ...baseRow,
        target_item_id: leadId,
      });
      return ok({ queued: "lead not found" });
    }

    // Already-dispositioned guard (#3): if the office pressed a disposition by
    // hand, write NOTHING — so a lead can never be routed twice. (The
    // at-the-door "No show text" marker doesn't count; the lead is still open.)
    if (hasExistingDisposition(block)) {
      await finish("queued", { target_item_id: leadId, board_id: block.boardId });
      await queue("needs_review", "already dispositioned by office", {
        ...baseRow,
        target_item_id: leadId,
        board_id: block.boardId,
      });
      return ok({ queued: "already dispositioned" });
    }

    const isCurrentBlock = block.boardId === activeSd || block.boardId === activeOc;
    const liveAllowed = mode === "live" && allowedBoards.has(block.boardId);

    // Details (Rule 3 / #6): rebuild now that the block is known, so a blank
    // arrival time falls back to the appointment time (date9, PT).
    const apptFallback =
      block.apptWallMinutes != null
        ? { hour: Math.floor(block.apptWallMinutes / 60), minute: block.apptWallMinutes % 60 }
        : null;
    const detailsLineForBlock = buildDetailsLine(form, formItem.createdAtMs, apptFallback);

    // Source Code fill (Rule 4), computed against the block's live values.
    const fieldWrites: Record<string, unknown> = { ...plan.fieldWrites };
    let sourceCodeNote = "";
    if (plan.fillSourceCodeIfBlank) {
      const { code, unknownSource } = sourceCodeToWrite(
        form.result,
        block.sourceCode,
        block.source,
      );
      if (code != null) fieldWrites[BLOCK_COL.sourceCode] = String(code);
      if (unknownSource)
        sourceCodeNote = ` (source "${block.source ?? ""}" unrecognized — set code=1)`;
    }
    // Details: APPEND, never overwrite (Rule 3).
    const combinedDetails = block.details?.trim()
      ? `${block.details.trim()}\n${detailsLineForBlock}`
      : detailsLineForBlock;
    const columnValues: Record<string, unknown> = {
      ...fieldWrites,
      [BLOCK_COL.details]: { text: combinedDetails },
    };

    const office: "SD" | "OC" | null = isCurrentBlock
      ? block.boardId === activeSd
        ? "SD"
        : "OC"
      : null;
    const rowWithTarget = {
      ...baseRow,
      details_line: detailsLineForBlock,
      target_item_id: leadId,
      board_id: block.boardId,
      office,
    };

    // Reps this report frees (the submitter + their partner, if any).
    const freedReps = [form.repName, form.partner].filter((r): r is string => !!r && !!r.trim());
    const resultLabel = (plan.status?.label ?? null) as string | null;

    if (!liveAllowed) {
      // dry-run / not allow-listed: store the plan, write nothing to the block.
      await finish("dry_run", { target_item_id: leadId, board_id: block.boardId });
      await queue(
        isCurrentBlock || mode === "dry_run" ? "dry_run" : "needs_review",
        mode === "dry_run" ? "dry-run preview" : "block not allow-listed for live writes",
        rowWithTarget,
      );
      // Live-issuing can still be REHEARSED here (no block was written, so it can
      // only ever simulate): compute + log the decision and text "[DRY RUN]…".
      if (dispatchMode !== "off" && office && !plan.atTheDoor) {
        await runDispatch({
          token,
          supabase,
          mode: "dry_run",
          office,
          block,
          reportedLeadId: leadId,
          reportedLeadName: block.name,
          reportedResultLabel: resultLabel,
          repNames: freedReps,
          nowMs: formItem.createdAtMs,
          formItemId,
        }).catch((e) => console.error("[ooh dispatch dry]", e instanceof Error ? e.message : e));
      }
      return ok({ dryRun: true, target: leadId, board: block.boardId });
    }

    // ── LIVE: Rule 1 order of writes — columns first, then ONE status ───────
    mondayTouched = true;
    if (Object.keys(columnValues).length > 0) {
      const r1 = await setColumns(
        token,
        block.boardId,
        leadId,
        columnValues,
        `ooh-cols-${formItemId}`,
      );
      if (r1.error) throw new Error(`setColumns: ${r1.error}`);
    }
    if (plan.status) {
      const r2 = await setStatus(
        token,
        block.boardId,
        leadId,
        plan.status.col,
        plan.status.label,
        `ooh-status-${formItemId}`,
      );
      if (r2.error) throw new Error(`setStatus: ${r2.error}`);
    }

    // Activity-log note on the block item. Keyed by the FORM item id so a
    // SECOND report on the same lead still posts its note (#7).
    await postUpdate(
      token,
      leadId,
      `Dispo report from ${form.repName ?? "rep"} at ${laClock(formItem.createdAtMs)} — ${formLink}${sourceCodeNote}`,
      oohUpdateKey(formItemId),
    ).catch(() => undefined);

    // SALE → text leadership (Tyler / Shai / Jorge) with a loud banner: the
    // rep(s), what they sold, how much. Best-effort; live mode only. A send
    // failure is logged to the queue (never blocks the write-back).
    const saleRes = await alertSaleOnce(block.name);
    const saleErr = saleTextError(saleRes);
    if (saleErr) {
      await supabase.from("ooh_report_queue").upsert(
        {
          form_item_id: formItemId,
          status: "error",
          reason: saleErr,
          error: saleErr,
          ...baseRow,
          target_item_id: leadId,
          board_id: block.boardId,
        },
        { onConflict: "form_item_id" },
      );
    }

    // The write-back succeeded → Dispatcher column shows Processed.
    await stampDispatcher(DISPATCHER_LABEL.processed);

    // ── Rule 6: at-the-door → message the office; issue nothing ─────────────
    let released: string | null = null;
    if (plan.atTheDoor) {
      await sendDispatcherIMessage(
        `No show at the door: ${block.name}, ${laClock(formItem.createdAtMs)}, ${form.repName ?? "rep"}. Office please call the lead.`,
      ).catch(() => undefined);
    } else if (dispatchMode !== "off" && office) {
      // ── Live issuing (Step 7): hand the freed rep(s) their next lead. In
      // live mode this writes people6 + Iss on Monday; in dry_run it only
      // computes, logs and texts "[DRY RUN]…". Never fails the write-back.
      released = await runDispatch({
        token,
        supabase,
        mode: dispatchMode === "live" ? "live" : "dry_run",
        office,
        block,
        reportedLeadId: leadId,
        reportedLeadName: block.name,
        reportedResultLabel: resultLabel,
        repNames: freedReps,
        nowMs: formItem.createdAtMs,
        formItemId,
      }).catch((e) => {
        console.error("[ooh dispatch]", e instanceof Error ? e.message : e);
        return null;
      });
    }

    await finish("written", { target_item_id: leadId, board_id: block.boardId });
    return ok({
      written: leadId,
      status: plan.status?.label ?? null,
      released,
      atTheDoor: plan.atTheDoor,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ooh] error", msg);
    // Keep the claim (outcome 'error') once Monday has been touched so a retry
    // never re-presses / re-appends; otherwise drop it so Monday can redeliver.
    if (mondayTouched) await finish("error");
    else await releaseClaimForRetry();
    // Keep rep + lead detail on the error row (#9) — baseRow is {} only if we
    // failed before parsing the form.
    await queue("error", msg, { ...baseRow, error: msg });
    // 200 so Monday doesn't hammer redelivery; the admin queue carries the error.
    return ok({ error: msg, mondayTouched });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE ISSUING — hand each freed rep their next lead (Step 7). Pure decision in
// dispatch.ts; this does the Monday reads/writes + the manager texts + the
// decision log. In 'live' it writes people6 then Iss (firing Monday's own "New
// Opportunity!" text); in 'dry_run' it only computes, logs and texts "[DRY
// RUN]…". Returns the issued lead id (live only), else null. Never throws past
// the caller's catch — a dispatch failure must never undo the write-back.
// ═══════════════════════════════════════════════════════════════════════════
async function runDispatch(p: {
  token: string;
  supabase: Supa;
  mode: "dry_run" | "live";
  office: "SD" | "OC";
  block: BlockItem;
  reportedLeadId: string;
  reportedLeadName: string | null;
  reportedResultLabel: string | null;
  repNames: string[];
  nowMs: number;
  formItemId: string;
}): Promise<string | null> {
  if (p.repNames.length === 0) return null;
  const weekday = laWeekday(p.nowMs);
  const nowWall = nowWallMinutes(p.nowMs);

  const [attendance, dayItems, users] = await Promise.all([
    fetchAttendance(p.token, p.office, weekday).catch(() => new Map()),
    fetchDispatchDayItems(p.token, p.block.boardId, p.block.groupId).catch(() => []),
    fetchMondayUsers(p.token).catch(() => [] as Array<{ id: string; name: string }>),
  ]);
  await enrichHistory(p.supabase, dayItems).catch(() => undefined);

  const chosen = new Set<string>(); // never issue the same lead to both partners
  let issued: string | null = null;
  const freeNone: string[] = [];

  for (const repName of p.repNames) {
    const att = attendance.get(firstName(repName));
    const working = !!att && (att.amOn || att.pmOn);
    const off = !!att && att.amOff && att.pmOff && !att.amOn && !att.pmOn;
    const openLeadCount = dayItems.filter(
      (l) =>
        l.itemId !== p.reportedLeadId &&
        l.reps.map(normName).includes(normName(repName)) &&
        isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
    ).length;
    const rep: DispatchRep = {
      name: repName,
      office: p.office,
      working,
      off,
      openLeadCount,
      lastCoords: p.block.coords,
    };
    const pool = dayItems.filter((l) => l.itemId !== p.reportedLeadId && !chosen.has(l.itemId));
    const plan = planIssue({ rep, dayLeads: pool, nowWallMinutes: nowWall });

    if (plan.action === "issue") {
      chosen.add(plan.lead.itemId);
      let didIssue = false;
      let failReason: string | null = null;
      if (p.mode === "live") {
        const uid = resolveUserId(users, repName);
        if (!uid) {
          failReason = `couldn't match ${repName} to a Monday user`;
        } else {
          // Manager-override safe: we only ever write to a lead that was Not
          // Issued (Tier A carries the rep; Tier B is unassigned) — never one a
          // person already touched.
          const r1 = await setPeopleColumn(
            p.token,
            plan.lead.boardId,
            plan.lead.itemId,
            BLOCK_COL.reps,
            [uid],
            `ooh-people-${plan.lead.itemId}`,
          );
          if (r1.error) failReason = `people6: ${r1.error}`;
          else {
            const r2 = await setStatus(
              p.token,
              plan.lead.boardId,
              plan.lead.itemId,
              BLOCK_COL.iss,
              LABEL.iss,
              `ooh-iss-${plan.lead.itemId}`,
            );
            if (r2.error) failReason = `Iss: ${r2.error}`;
            else {
              didIssue = true;
              issued = plan.lead.itemId;
            }
          }
        }
      }
      if (failReason) {
        await sendDispatcherIMessage(
          `Dispatch could not issue ${plan.lead.name} to ${repName}: ${failReason}. Please assign by hand.`,
        ).catch(() => undefined);
      } else {
        await sendDispatcherIMessage(
          buildIssuedText({
            repName,
            lead: plan.lead,
            outOfLeadName: p.reportedLeadName,
            outOfResultLabel: p.reportedResultLabel,
            dryRun: p.mode !== "live",
          }),
        ).catch(() => undefined);
      }
      await logDispatchDecision(p.supabase, {
        mode: p.mode,
        trigger: "report",
        formItemId: p.formItemId,
        repName,
        office: p.office,
        boardId: plan.lead.boardId,
        leadItemId: plan.lead.itemId,
        leadName: plan.lead.name,
        action: failReason ? "manager" : "issue",
        score: plan.score,
        driveMinutes: plan.driveMinutes,
        strength: plan.strength,
        reason: failReason ?? plan.reason,
        issued: didIssue,
      });
    } else if (plan.action === "manager") {
      await sendDispatcherIMessage(
        `Dispatch — managers please assign: ${plan.lead.name} (${plan.reason}).`,
      ).catch(() => undefined);
      await logDispatchDecision(p.supabase, {
        mode: p.mode,
        trigger: "report",
        formItemId: p.formItemId,
        repName,
        office: p.office,
        boardId: plan.lead.boardId,
        leadItemId: plan.lead.itemId,
        leadName: plan.lead.name,
        action: "manager",
        score: null,
        driveMinutes: null,
        strength: null,
        reason: plan.reason,
        issued: false,
      });
    } else {
      if (working && !off) freeNone.push(repName);
      await logDispatchDecision(p.supabase, {
        mode: p.mode,
        trigger: "report",
        formItemId: p.formItemId,
        repName,
        office: p.office,
        boardId: p.block.boardId,
        leadItemId: null,
        leadName: null,
        action: "none",
        score: null,
        driveMinutes: null,
        strength: null,
        reason: plan.reason,
        issued: false,
      });
    }
  }

  if (freeNone.length) {
    await sendDispatcherIMessage(buildFreeRepsLine(freeNone)).catch(() => undefined);
  }
  return issued;
}
