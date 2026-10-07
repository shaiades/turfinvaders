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
  createItem,
  fetchAttendance,
  fetchBlockItem,
  fetchDispatchDayItems,
  fetchFormItem,
  fetchMondayUsers,
  resolveUserId,
  setColumns,
  setPeopleColumn,
  setStatus,
} from "./monday.ts";
import { sendDispatcherIMessage, type InkboxResult } from "./inkbox.ts";
import {
  BLOCK_COL,
  BLOCK_DAY_GROUP,
  DISPATCHER_LABEL,
  FORM_BOARD_ID,
  OOH_DISPATCHER_COL,
  SOURCE_CODE_COL,
  addOnReloadLabels,
  buildBaseQueueRow,
  buildCanSaveDetails,
  buildDetailsLine,
  buildOffBlockCreate,
  buildOffBlockText,
  buildSaleAlert,
  buildSalesProcMissingText,
  hasExistingDisposition,
  isAllowedOohBoard,
  isCanSaveOfficeAppt,
  isOpenLead,
  isSaleResult,
  LABEL,
  laClock,
  laWeekday,
  matchByLastNameAndRep,
  matchTarget,
  normName,
  parseOohForm,
  parsePaymentDetails,
  planDisposition,
  sameCustomer,
  secondReportOutcome,
  soldFollowupMissing,
  sourceCodeToWrite,
} from "./engine.ts";
import {
  type DispatchRep,
  attendanceWithOverride,
  buildFreeRepsLine,
  buildIssuedText,
  buildNeverAloneText,
  decidePairing,
  firstName,
  isFreeRep,
  nowWallMinutes,
  planIssue,
  sameRep,
} from "./dispatch.ts";
import { fetchAttendanceOverrides, runWatchdog } from "./watchdog.ts";
import { enqueueSalesProcFollowup } from "./salesproc.ts";
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
    // Notify the office for anything that needs a human (best-effort).
    if (status === "needs_review" || status === "error") {
      await sendDispatcherIMessage(
        `Dispo report needs review: ${String(row.rep_name ?? "?")}, result ${String(row.result ?? "?")}. Open Close Kombat → Dispo.`,
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
    baseRow = buildBaseQueueRow(form, detailsLine, plan);

    // A plan the engine refuses to auto-apply (e.g. a reset result with no
    // reset date) goes to the office — press nothing (#4). For a report that
    // targets a block item we defer the check until the block is read: a
    // can-save presses no button at all, so a missing reset date can't block it.
    if (plan.needsReview && target.kind !== "write") {
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

    // The block item this report lands on. Filled by the Lead ID, the
    // last-name+rep fallback, or the off-block add below.
    let leadId: string | null =
      target.kind === "write" ? ((target as { leadId?: string }).leadId ?? form.leadId) : null;
    // Set when this report ADDED (or adopted) an off-block item — drives the
    // "Off-block …: added to today's block" manager text after the write.
    let offBlock: { office: "SD" | "OC"; customer: string } | null = null;
    const weekday = laWeekday(formItem.createdAtMs);
    const dayGroupId = BLOCK_DAY_GROUP[weekday];

    // ── On-block report with NO Lead ID: customer last name + rep, today's
    // group (owner rule). Anything but one confident hit → Needs review. ─────
    if (target.kind === "queue") {
      // One confident hit ACROSS both offices, or nothing — never a guess.
      const pooled: Array<{ itemId: string; name: string; reps: string[] }> = [];
      for (const b of [activeSd, activeOc]) {
        if (!b) continue;
        const items = await fetchDispatchDayItems(token, b, dayGroupId).catch(() => []);
        for (const it of items) pooled.push({ itemId: it.itemId, name: it.name, reps: it.reps });
      }
      const m = matchByLastNameAndRep({
        customerName: formItem.name || null,
        repName: form.repName,
        partner: form.partner,
        items: pooled,
      });
      if (m.kind === "match") {
        leadId = m.itemId;
      } else {
        await finish("queued");
        await queue(
          "needs_review",
          m.kind === "ambiguous"
            ? `several leads match this name + rep today (${m.count})`
            : target.reason,
          baseRow,
        );
        return ok({ queued: target.reason });
      }
    }

    // ── Off-block report (upsell / reload / self-gen): ADD it to today's block
    // in the rep's office, unless the same customer is already there. ────────
    if (target.kind === "create") {
      const autocreate = (settings?.ooh_autocreate as boolean | null) ?? false;
      if (!autocreate) {
        await finish("queued");
        const saleRes = await alertSaleOnce(formItem.name || form.address); // self-gen SALE → text now
        const ste = saleTextError(saleRes);
        await queue("needs_review", `auto-create off — ${target.reason}`, {
          ...baseRow,
          ...(ste ? { error: ste } : {}),
        });
        return ok({ queued: "create (auto-create off)" });
      }
      const customer = (formItem.name || form.address || "").trim();
      if (mode !== "live") {
        // dry_run: show what WOULD be added; create nothing.
        await finish("dry_run");
        await queue("dry_run", "would add off-block item to today's block", baseRow);
        return ok({ dryRun: true, wouldCreate: customer });
      }
      // The rep's office comes from the attendance boards (first-name rosters).
      const [sdAtt, ocAtt] = await Promise.all([
        fetchAttendance(token, "SD", weekday).catch(() => new Map()),
        fetchAttendance(token, "OC", weekday).catch(() => new Map()),
      ]);
      const fn = firstName(form.repName ?? "");
      const inSd = !!fn && sdAtt.has(fn);
      const inOc = !!fn && ocAtt.has(fn);
      const office: "SD" | "OC" | null = inSd && !inOc ? "SD" : inOc && !inSd ? "OC" : null;
      const boardId = office === "SD" ? activeSd : office === "OC" ? activeOc : null;
      if (!customer || !office || !boardId) {
        await finish("queued");
        const saleRes = await alertSaleOnce(customer || form.address);
        const ste = saleTextError(saleRes);
        await queue(
          "needs_review",
          !customer
            ? "off-block report with no customer name"
            : "couldn't resolve the rep's office for the off-block add",
          { ...baseRow, ...(ste ? { error: ste } : {}) },
        );
        return ok({ queued: "off-block (unresolved)" });
      }
      const dayItems = await fetchDispatchDayItems(token, boardId, dayGroupId).catch(() => []);
      const existing = dayItems.find((it) => sameCustomer(it.name, customer));
      if (existing) {
        leadId = existing.itemId;
      } else {
        const users = await fetchMondayUsers(token).catch(
          () => [] as Array<{ id: string; name: string }>,
        );
        const uids = [form.repName, form.partner]
          .map((n) => (n ? resolveUserId(users, n) : null))
          .filter((x): x is string => !!x);
        const create = buildOffBlockCreate({
          form,
          customerName: customer,
          submitMs: formItem.createdAtMs,
          office,
          repUserIds: uids,
        });
        if (!create) {
          await finish("queued");
          await queue("needs_review", "off-block report with no on-block channel", baseRow);
          return ok({ queued: "off-block (no channel)" });
        }
        mondayTouched = true;
        const newId = await createItem(
          token,
          boardId,
          dayGroupId,
          create.name,
          create.columnValues,
          `ooh-create-${formItemId}`,
        );
        if (!newId) throw new Error("off-block create_item failed");
        leadId = newId;
      }
      offBlock = { office, customer };
    }

    // ── matched lead: resolve + gate ────────────────────────────────────────
    if (!leadId) {
      await finish("queued");
      await queue("needs_review", "no target lead resolved", baseRow);
      return ok({ queued: "no target" });
    }
    const block = await fetchBlockItem(token, leadId);
    if (!block || block.state !== "active") {
      await finish("queued");
      await queue("needs_review", "Lead ID not found or inactive on any block", {
        ...baseRow,
        target_item_id: leadId,
      });
      return ok({ queued: "lead not found" });
    }

    // Already-dispositioned guard (#3): if a disposition is already set, write
    // NOTHING — a lead can never be routed twice. When WE wrote that first
    // disposition, this is the PARTNER's copy of the same report (owner rule:
    // process the first, mark the second Processed as a duplicate); a human
    // disposition still goes to the office for review. (The at-the-door
    // "No show text" marker doesn't count; the lead is still open.)
    if (hasExistingDisposition(block)) {
      const { data: prior } = await supabase
        .from("ooh_processed_reports")
        .select("form_item_id")
        .eq("target_item_id", leadId)
        .eq("outcome", "written")
        .neq("form_item_id", formItemId)
        .limit(1);
      const outcome = secondReportOutcome({
        alreadyDispositioned: true,
        writtenByUs: (prior ?? []).length > 0,
      });
      if (outcome === "duplicate") {
        await finish("duplicate", { target_item_id: leadId, board_id: block.boardId });
        await stampDispatcher(DISPATCHER_LABEL.processed);
        return ok({ duplicate: true, target: leadId });
      }
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
    const office: "SD" | "OC" | null = isCurrentBlock
      ? block.boardId === activeSd
        ? "SD"
        : "OC"
      : null;

    // ── Can-save (owner rule): the matched item is an Office Appt carrying the
    // can/save marker → append the result to Details and press NO button (the
    // outcome lives in Details + the WCC flow). The rep is then free. ─────────
    const blockFreeText = [block.source, block.agent, block.comments, block.details]
      .filter(Boolean)
      .join(" | ");
    const canSave = isCanSaveOfficeAppt({ issLabel: block.iss, freeText: blockFreeText });
    if (canSave) {
      plan.status = null;
      plan.fillSourceCodeIfBlank = false;
      plan.fieldWrites = {};
    }

    // Deferred needs-review (see above): with a block in hand, only a plan that
    // still presses a button can be unroutable.
    if (plan.needsReview && !canSave) {
      await finish("queued");
      await queue("needs_review", plan.needsReview, {
        ...baseRow,
        target_item_id: leadId,
        board_id: block.boardId,
      });
      return ok({ queued: plan.needsReview });
    }

    // Details (Rule 3 / #6): rebuild now that the block is known, so a blank
    // arrival time falls back to the appointment time (date9, PT).
    const apptFallback =
      block.apptWallMinutes != null
        ? { hour: Math.floor(block.apptWallMinutes / 60), minute: block.apptWallMinutes % 60 }
        : null;
    const detailsLineForBlock = canSave
      ? buildCanSaveDetails(form, formItem.createdAtMs)
      : buildDetailsLine(form, formItem.createdAtMs, apptFallback);

    // Source Code fill (Rule 4), computed against the block's live values. The
    // column id differs per office (SD numeric_mm35kwnj / OC numeric_mm35nm4y).
    const fieldWrites: Record<string, unknown> = { ...plan.fieldWrites };
    let sourceCodeNote = "";
    if (plan.fillSourceCodeIfBlank) {
      const { code, unknownSource } = sourceCodeToWrite(
        form.result,
        block.sourceCode,
        block.source,
      );
      if (code != null) fieldWrites[SOURCE_CODE_COL[office ?? "SD"]] = String(code);
      if (unknownSource)
        sourceCodeNote = ` (source "${block.source ?? ""}" unrecognized — set code=1)`;
    }

    // ── Every Sold (owner 10/6): Advantage+ and the add-on Reloads go on the
    // block BEFORE the Sold press. Values come from the rep's own words — a
    // membership never guessed, add-ons = quoted beyond the card's product(s)
    // plus promised future reloads. ──────────────────────────────────────────
    const payText = [form.notes, form.quantities, form.whatHappened].filter(Boolean).join("\n");
    const pay = parsePaymentDetails(payText);
    const addOns =
      isSaleResult(form) && !canSave
        ? addOnReloadLabels({
            quoted: form.quotedText,
            blockProducts: block.products,
            notes: form.notes,
          })
        : [];
    if (isSaleResult(form) && !canSave) {
      if (pay.advantage) fieldWrites[BLOCK_COL.advantage] = { label: pay.advantage };
      if (addOns.length > 0 && fieldWrites[BLOCK_COL.reloads] == null) {
        fieldWrites[BLOCK_COL.reloads] = { labels: addOns };
      }
    }

    // Details: APPEND, never overwrite (Rule 3).
    const combinedDetails = block.details?.trim()
      ? `${block.details.trim()}\n${detailsLineForBlock}`
      : detailsLineForBlock;
    const columnValues: Record<string, unknown> = {
      ...fieldWrites,
      [BLOCK_COL.details]: { text: combinedDetails },
    };
    const rowWithTarget = {
      ...baseRow,
      details_line: detailsLineForBlock,
      target_item_id: leadId,
      board_id: block.boardId,
      office,
      // The dry-run preview must show the FULL first call (incl. Advantage+,
      // add-on Reloads, per-office Source Code) — not just the form-derived
      // plan — so a shadow day is comparable to what live would write.
      plan: { ...plan, columnValues } as unknown,
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

    // NO Monday updates/comments on the block or Dispo items (owner 10/6 —
    // they notify reps and managers). The Details column carries the record;
    // an unrecognized Source lands in the admin cockpit instead (the write
    // itself succeeded — the office just double-checks the code).
    if (sourceCodeNote) {
      await supabase.from("ooh_report_queue").upsert(
        {
          form_item_id: formItemId,
          status: "needs_review",
          reason: `written, but ${sourceCodeNote.trim()}`,
          ...baseRow,
          target_item_id: leadId,
          board_id: block.boardId,
        },
        { onConflict: "form_item_id" },
      );
    }

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

    // Off-block add → tell the managers what landed where (owner rule).
    if (offBlock) {
      await sendDispatcherIMessage(buildOffBlockText(form, offBlock.customer)).catch(
        () => undefined,
      );
    }

    // ── Sold follow-up (owner 10/6): the item moves to Sales Processing with
    // the same id; queue the Deposit/Finance/Advantage+/Reloads fill (the
    // watchdog drains it once the move lands) and ask the managers ONCE for
    // whatever the report lacked. Plain Sold only — Upsell/Reload route as
    // subitems of the original sale. ─────────────────────────────────────────
    if (plan.status?.label === LABEL.sold) {
      await enqueueSalesProcFollowup(supabase, {
        form_item_id: formItemId,
        lead_item_id: leadId,
        customer: block.name || offBlock?.customer || null,
        deposit_amount: pay.depositAmount,
        finance_labels: pay.financeLabels.length > 0 ? pay.financeLabels : null,
        advantage: pay.advantage,
        reload_labels: addOns.length > 0 ? addOns : null,
      });
      const missing = soldFollowupMissing(form, pay);
      if (missing.length > 0) {
        await sendDispatcherIMessage(
          buildSalesProcMissingText(block.name || offBlock?.customer || null, missing),
        ).catch(() => undefined);
      }
    }

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

  const [attendance, overrides, dayItems, users] = await Promise.all([
    fetchAttendance(p.token, p.office, weekday).catch(() => new Map()),
    fetchAttendanceOverrides(p.supabase, p.office, p.nowMs),
    fetchDispatchDayItems(p.token, p.block.boardId, p.block.groupId).catch(() => []),
    fetchMondayUsers(p.token).catch(() => [] as Array<{ id: string; name: string }>),
  ]);
  await enrichHistory(p.supabase, dayItems).catch(() => undefined);

  // The freed reps as planner inputs. A manager attendance override (set in
  // Turf Invaders) BEATS the attendance board — it's sometimes wrong (owner).
  const freedReps: DispatchRep[] = p.repNames.map((repName) => {
    const att = attendance.get(firstName(repName));
    const boardState = {
      working: !!att && (att.amOn || att.pmOn),
      off: !!att && att.amOff && att.pmOff && !att.amOn && !att.pmOn,
    };
    const state = attendanceWithOverride(boardState, overrides.get(firstName(repName)) ?? null);
    const openLeadCount = dayItems.filter(
      (l) =>
        l.itemId !== p.reportedLeadId &&
        l.reps.map(normName).includes(normName(repName)) &&
        isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
    ).length;
    return {
      name: repName,
      office: p.office,
      working: state.working,
      off: state.off,
      openLeadCount,
      lastCoords: p.block.coords,
    };
  });

  // Pairing table (owner 10/6): who rides together, who must not go alone.
  const pairing = decidePairing(freedReps.filter((r) => isFreeRep(r)));
  for (const held of pairing.holdAlone) {
    await sendDispatcherIMessage(buildNeverAloneText(held.name)).catch(() => undefined);
    await logDispatchDecision(p.supabase, {
      mode: p.mode,
      trigger: "report",
      formItemId: p.formItemId,
      repName: held.name,
      office: p.office,
      boardId: p.block.boardId,
      leadItemId: null,
      leadName: null,
      action: "manager",
      score: null,
      driveMinutes: null,
      strength: null,
      reason: "never rides alone — managers pair by hand",
      issued: false,
    });
  }
  // Reps that aren't free still get a logged "none" decision below.
  const groups: DispatchRep[][] = [
    ...pairing.groups,
    ...freedReps.filter((r) => !isFreeRep(r)).map((r) => [r]),
  ];

  const chosen = new Set<string>(); // never issue the same lead twice
  let issued: string | null = null;
  const freeNone: string[] = [];

  for (const group of groups) {
    const [rep, coRep] = group;
    const groupLabel = group.map((g) => g.name).join(" & ");
    const pool = dayItems.filter((l) => l.itemId !== p.reportedLeadId && !chosen.has(l.itemId));
    const plan = planIssue({ rep, coRep: coRep ?? null, dayLeads: pool, nowWallMinutes: nowWall });

    if (plan.action === "issue") {
      chosen.add(plan.lead.itemId);
      let didIssue = false;
      let failReason: string | null = null;
      let silentSkip = false;
      if (p.mode === "live") {
        const uids = group.map((g) => resolveUserId(users, g.name)).filter((x): x is string => !!x);
        if (uids.length !== group.length) {
          failReason = `couldn't match ${groupLabel} to a Monday user`;
        } else {
          // Manager overrides always win (owner 10/6): re-read the lead right
          // before writing — if a person changed Reps or the status since we
          // planned, leave it exactly as they set it.
          const fresh = await fetchBlockItem(p.token, plan.lead.itemId).catch(() => null);
          const freshOk =
            !!fresh &&
            (fresh.iss ?? "").trim() === LABEL.notIssued &&
            (fresh.reps.length === 0 ||
              fresh.reps.every((r) => group.some((g) => sameRep(g.name, r))));
          if (!freshOk) {
            failReason = "lead changed since planning (manager override) — left untouched";
            silentSkip = true;
          } else {
            const r1 = await setPeopleColumn(
              p.token,
              plan.lead.boardId,
              plan.lead.itemId,
              BLOCK_COL.reps,
              uids,
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
      }
      if (failReason) {
        if (!silentSkip) {
          await sendDispatcherIMessage(
            `Dispatch could not issue ${plan.lead.name} to ${groupLabel}: ${failReason}. Please assign by hand.`,
          ).catch(() => undefined);
        }
      } else {
        await sendDispatcherIMessage(
          buildIssuedText({
            repName: rep.name,
            partnerName: coRep?.name ?? null,
            lead: plan.lead,
            outOfLeadName: p.reportedLeadName,
            outOfResultLabel: p.reportedResultLabel,
            dryRun: p.mode !== "live",
            lateMinutes: plan.lateMinutes,
          }),
        ).catch(() => undefined);
      }
      await logDispatchDecision(p.supabase, {
        mode: p.mode,
        trigger: "report",
        formItemId: p.formItemId,
        repName: groupLabel,
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
        repName: groupLabel,
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
      for (const g of group) if (isFreeRep(g)) freeNone.push(g.name);
      await logDispatchDecision(p.supabase, {
        mode: p.mode,
        trigger: "report",
        formItemId: p.formItemId,
        repName: groupLabel,
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
