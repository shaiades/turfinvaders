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
//
// TEXT NOISE (owner mandate 2026-10-07 — Inkbox caps iMessage at 100/day): the
// dispatcher phone (Shai/Tyler/Jorge) is texted for ONLY four things —
//   1. a sale / reload / upsell (buildSaleAlert, with the "missing sale info"
//      nudge folded into that one text);
//   2. a no-show at the door;
//   3. an uncovered lead within 60 min (the watchdog);
//   4. (there is no 4th — #1's folded nudge is the "missing sale info" case).
// EVERYTHING ELSE that used to buzz the phone — a dispo that needs review or
// errored, a routine "Issued:", a "[DRY RUN] would issue", "Free reps", a
// could-not-issue, a managers-please-assign — now shows in the Close Kombat →
// Dispo "Needs review" list instead (ooh_report_queue) and/or the decision log.
// ═══════════════════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { makeClient, type Supa } from "./supa.ts";
import {
  type BlockItem,
  type FormItem,
  createItem,
  fetchAttendance,
  fetchBlockItem,
  fetchDispatchDayItems,
  fetchFormItem,
  fetchItemActivity,
  fetchMatchCandidates,
  fetchMondayMe,
  fetchMondayUsers,
  fetchPeopleColumnIds,
  findItemOnBoardByName,
  mondayGraphql,
  postUpdate,
  resolveUserId,
  resolveUserIdByFirstName,
  setColumns,
  setPeopleColumn,
  setStatus,
} from "./monday.ts";
import { sendDispatcherIMessage, type InkboxResult } from "./inkbox.ts";
import {
  BLOCK_COL,
  BLOCK_DAY_GROUP,
  DESTINATION_BOARDS,
  DISPATCHER_LABEL,
  FORM_BOARD_ID,
  GUARDED_WRITE_COLS,
  OFFICE_LABEL,
  type MatchCandidate,
  OOH_DISPATCHER_COL,
  blockDayGroupForAppt,
  buildBaseQueueRow,
  buildDetailsLine,
  buildNoShowAtDoorText,
  buildSaleAlert,
  createSourceText,
  customerDayKey,
  hasExistingDisposition,
  humanTouchedGuardedColsToday,
  isAllowedOohBoard,
  isHandledDestinationBoard,
  isOfficeApptStatus,
  isOpenLead,
  isSaleResult,
  laClock,
  laDate,
  laWeekday,
  matchTarget,
  matchWeekday,
  matchWithoutLeadId,
  normName,
  oohUpdateKey,
  parseOohForm,
  planDisposition,
  planOfficeApptDisposition,
  planSalesProcessingWrite,
  sourceCodeColId,
  sourceCodeToWrite,
  weekdayOfDate,
  type WritePlan,
} from "./engine.ts";
import {
  type DispatchPairingOverride,
  type DispatchRep,
  choosePartner,
  firstName,
  inferCreateOffice,
  isFreeRep,
  isNeverSolo,
  issLabelForLead,
  mergePeople,
  mustPair,
  nowWallMinutes,
  planIssue,
  withPairing,
} from "./dispatch.ts";
import { runWatchdog } from "./watchdog.ts";
import { runApprovalsDecision, runBuildApprovals } from "./approvals-live.ts";
import { APPROVALS_BOARD_ID, APPROVALS_COL, type ProposalInput } from "./approvals.ts";
import { enrichHistory, logDispatchDecision, logDispatchWrite } from "./history.ts";

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

/** Deploy-side admin auth: x-admin-key must digest-match the service-role key
 *  (same scheme the Rule 13 webhook registration shipped with). */
async function adminKeyOk(req: Request): Promise<boolean> {
  const digest = async (v: string) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return Array.from(new Uint8Array(d))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const adminKey = req.headers.get("x-admin-key") ?? "";
  const serviceKey = denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !adminKey) return false;
  return (await digest(adminKey)) === (await digest(serviceKey));
}

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

  // ── Rule 13: Sales Processing fill ──────────────────────────────────────────
  // Pointed at by the Sales Processing board's "item created" webhook
  // (…/monday-ooh-report?task=sales-processing&secret=…). When a Sold routes a
  // card onto board 4155553389, fill its deposit / finance / Advantage+ /
  // reloads from the pending row stored when the sale button was pressed.
  if (url.searchParams.get("task") === "sales-processing") {
    const spSecret = denoEnv?.get("MONDAY_OOH_SECRET") ?? denoEnv?.get("MONDAY_WEBHOOK_SECRET");
    const spProvided = req.headers.get("x-monday-secret") ?? url.searchParams.get("secret");
    const spEnforce =
      denoEnv?.get("MONDAY_OOH_ENFORCE_SECRET") === "true" ||
      denoEnv?.get("MONDAY_WEBHOOK_ENFORCE_SECRET") === "true";
    if (spSecret && spProvided !== spSecret && spEnforce) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const spRaw = await req.text();
    let spBody: Record<string, unknown> = {};
    try {
      spBody = spRaw ? JSON.parse(spRaw) : {};
    } catch {
      return ok({ ignored: "non-JSON body" });
    }
    if (spBody.challenge) {
      return new Response(JSON.stringify({ challenge: spBody.challenge }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const spEvent = ((spBody.data as Record<string, unknown>)?.event ??
      (spBody.event as Record<string, unknown>) ??
      spBody) as Record<string, unknown>;
    const spItemId = String(spEvent.pulseId ?? spEvent.itemId ?? spEvent.pulse_id ?? "");
    const spName = String(spEvent.pulseName ?? spEvent.itemName ?? "");
    if (!spItemId || !/^\d+$/.test(spItemId)) return ok({ ignored: "no SP item id" });
    const supabase = makeClient(
      denoEnv?.get("SUPABASE_URL") ?? "",
      denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: spSettings } = await supabase
      .from("system_settings")
      .select("monday_api_token")
      .maybeSingle();
    const spToken = ((spSettings?.monday_api_token as string | null) ?? "").trim();
    if (!spToken) return ok({ ignored: "no token" });
    const res = await fillSalesProcessingForItem(spToken, supabase, spItemId, spName).catch(
      (e) => ({
        filled: false,
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
    return ok(res);
  }

  // ── Nightly Approvals: Decision webhook (rules H4/H5, I, J10) ──────────────
  // Pointed at by the approvals board's Decision-column webhook
  // (…/monday-ooh-report?task=approvals&secret=…). A manager pressing Approve /
  // Don't approve / Change / Add rep lands here; nothing on a block item is
  // ever written except through this path's add-only, re-read-guarded apply.
  if (url.searchParams.get("task") === "approvals") {
    const apSecret = denoEnv?.get("MONDAY_OOH_SECRET") ?? denoEnv?.get("MONDAY_WEBHOOK_SECRET");
    const apProvided = req.headers.get("x-monday-secret") ?? url.searchParams.get("secret");
    const apEnforce =
      denoEnv?.get("MONDAY_OOH_ENFORCE_SECRET") === "true" ||
      denoEnv?.get("MONDAY_WEBHOOK_ENFORCE_SECRET") === "true";
    if (apSecret && apProvided !== apSecret && apEnforce) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const apRaw = await req.text();
    let apBody: Record<string, unknown> = {};
    try {
      apBody = apRaw ? JSON.parse(apRaw) : {};
    } catch {
      return ok({ ignored: "non-JSON body" });
    }
    if (apBody.challenge) {
      return new Response(JSON.stringify({ challenge: apBody.challenge }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const apEvent = ((apBody.data as Record<string, unknown>)?.event ??
      (apBody.event as Record<string, unknown>) ??
      apBody) as Record<string, unknown>;
    const apItemId = String(apEvent.pulseId ?? apEvent.itemId ?? apEvent.pulse_id ?? "");
    if (!apItemId || !/^\d+$/.test(apItemId)) return ok({ ignored: "no approvals item id" });
    const apLabel =
      ((apEvent.value as Record<string, unknown>)?.label as { text?: string } | undefined)?.text ??
      (typeof (apEvent.value as Record<string, unknown>)?.label === "string"
        ? String((apEvent.value as Record<string, unknown>).label)
        : null) ??
      (apEvent.textValue != null ? String(apEvent.textValue) : null);
    const supabase = makeClient(
      denoEnv?.get("SUPABASE_URL") ?? "",
      denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const apRes = await runApprovalsDecision(supabase, {
      itemId: apItemId,
      columnId: apEvent.columnId != null ? String(apEvent.columnId) : null,
      label: apLabel,
      userId: apEvent.userId != null ? String(apEvent.userId) : null,
    }).catch((e) => ({
      handled: false,
      reason: e instanceof Error ? e.message : String(e),
    }));
    return ok(apRes);
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

  // ── Admin: ensure the Sales Processing "item created" webhook (Rule 13) ────
  // Deploy-side tooling, not a Monday event (owner-approved 2026-10-08). The
  // delivery URL must carry the shared webhook secret, and that secret lives
  // only in this function's env — so the function registers its own webhook,
  // exactly like monday-live-dispatch's ensure_lead_date_webhook. Auth: the
  // project's service-role key in x-admin-key, compared by digest. Handled
  // BEFORE the Monday secret gate (this call legitimately carries no Monday
  // secret).
  if (body.adminAction === "ensure_sales_processing_webhook") {
    const digest = async (v: string) => {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
      return Array.from(new Uint8Array(d))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    };
    const adminKey = req.headers.get("x-admin-key") ?? "";
    const serviceKey = denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!serviceKey || !adminKey || (await digest(adminKey)) !== (await digest(serviceKey))) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const webhookSecret =
      denoEnv?.get("MONDAY_OOH_SECRET") ?? denoEnv?.get("MONDAY_WEBHOOK_SECRET") ?? "";
    if (!webhookSecret) {
      return ok({
        ok: false,
        error: "MONDAY_OOH_SECRET is not set — refusing to register a secretless webhook",
      });
    }
    const admin = makeClient(
      denoEnv?.get("SUPABASE_URL") ?? "",
      denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: sRow } = await admin
      .from("system_settings")
      .select("id, monday_api_token, monday_webhooks")
      .limit(1)
      .maybeSingle();
    const adminToken = ((sRow?.monday_api_token as string | null) ?? "").trim();
    if (!adminToken) return ok({ ok: false, error: "no Monday token in system_settings" });
    const spBoard = DESTINATION_BOARDS.salesProcessing;
    const listRes = await mondayGraphql(
      adminToken,
      `query { webhooks (board_id: ${spBoard}) { id event } }`,
    );
    if (listRes.error) return ok({ ok: false, error: `webhook list failed: ${listRes.error}` });
    const hooks = (listRes.data?.webhooks ?? []) as Array<{ id: string; event: string }>;
    // Monday doesn't expose a webhook's URL, so an existing create_item hook
    // can't be verified as OURS — report it and only create alongside it when
    // the caller explicitly passes force:true.
    const existing = hooks.filter((h) => h.event === "create_item");
    if (existing.length > 0 && body.force !== true) {
      return ok({
        ok: true,
        existing: existing.map((h) => String(h.id)),
        note: "a create_item webhook already exists on Sales Processing — pass force:true to register ours alongside it",
      });
    }
    const hookUrl = `https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=sales-processing&secret=${webhookSecret}`;
    if (hookUrl.length > 255) {
      return ok({
        ok: false,
        error: `webhook URL is ${hookUrl.length} chars — Monday caps at 255`,
      });
    }
    const createRes = await mondayGraphql(
      adminToken,
      `mutation { create_webhook (board_id: ${spBoard}, url: ${JSON.stringify(hookUrl)}, event: create_item) { id } }`,
    );
    const createdId = (createRes.data?.create_webhook as { id?: string } | undefined)?.id;
    if (createRes.error || !createdId) {
      return ok({
        ok: false,
        error: `create_webhook failed: ${createRes.error ?? "no id returned"}`,
      });
    }
    const registry = Array.isArray(sRow?.monday_webhooks)
      ? [...(sRow.monday_webhooks as unknown[])]
      : [];
    registry.push({
      event: "create_item",
      board_id: spBoard,
      webhook_id: String(createdId),
      registered_at: new Date().toISOString(),
      purpose: "rule13-sales-processing-fill",
    });
    await admin
      .from("system_settings")
      .update({ monday_webhooks: registry })
      .eq("id", (sRow as { id: unknown }).id);
    return ok({ ok: true, created: String(createdId) });
  }

  // ── Admin: build/refresh tomorrow's Nightly Approvals full-block view ──────
  // (rules H1–H3). Writes ONLY the approvals board. Body: { dateISO?,
  // proposals?: [{ blockItemId, proposedReps?/addReps?, reason }] } — the
  // nightly planning session passes its proposals here; replace-shaped ones
  // are converted to add-only (rules I6–I9) before anything is shown.
  if (body.adminAction === "build_nightly_approvals") {
    if (!(await adminKeyOk(req))) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const admin = makeClient(
      denoEnv?.get("SUPABASE_URL") ?? "",
      denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const res = await runBuildApprovals(admin, {
      dateISO: typeof body.dateISO === "string" ? body.dateISO : undefined,
      proposals: Array.isArray(body.proposals) ? (body.proposals as ProposalInput[]) : [],
    }).catch((e) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    return ok(res);
  }

  // ── Admin: ensure the approvals board's Decision webhook ───────────────────
  // Registers change_status_column_value on the Decision column of board
  // 18433860636 → …?task=approvals&secret=…, exactly like the Rule 13 hook.
  if (body.adminAction === "ensure_approvals_webhook") {
    if (!(await adminKeyOk(req))) {
      return new Response("unauthorized", { status: 401, headers: corsHeaders });
    }
    const webhookSecret =
      denoEnv?.get("MONDAY_OOH_SECRET") ?? denoEnv?.get("MONDAY_WEBHOOK_SECRET") ?? "";
    if (!webhookSecret) {
      return ok({
        ok: false,
        error: "MONDAY_OOH_SECRET is not set — refusing to register a secretless webhook",
      });
    }
    const admin = makeClient(
      denoEnv?.get("SUPABASE_URL") ?? "",
      denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const { data: sRow } = await admin
      .from("system_settings")
      .select("id, monday_api_token, monday_webhooks")
      .limit(1)
      .maybeSingle();
    const adminToken = ((sRow?.monday_api_token as string | null) ?? "").trim();
    if (!adminToken) return ok({ ok: false, error: "no Monday token in system_settings" });
    const listRes = await mondayGraphql(
      adminToken,
      `query { webhooks (board_id: ${APPROVALS_BOARD_ID}) { id event } }`,
    );
    if (listRes.error) return ok({ ok: false, error: `webhook list failed: ${listRes.error}` });
    const hooks = (listRes.data?.webhooks ?? []) as Array<{ id: string; event: string }>;
    const existing = hooks.filter((h) => h.event === "change_status_column_value");
    if (existing.length > 0 && body.force !== true) {
      return ok({
        ok: true,
        existing: existing.map((h) => String(h.id)),
        note: "a change_status_column_value webhook already exists on the approvals board — pass force:true to register ours alongside it",
      });
    }
    const hookUrl = `https://xogitpqeuwalerxygvjw.supabase.co/functions/v1/monday-ooh-report?task=approvals&secret=${webhookSecret}`;
    if (hookUrl.length > 255) {
      return ok({ ok: false, error: `webhook URL is ${hookUrl.length} chars — Monday caps at 255` });
    }
    const cfg = JSON.stringify(JSON.stringify({ columnId: APPROVALS_COL.decision }));
    const createRes = await mondayGraphql(
      adminToken,
      `mutation { create_webhook (board_id: ${APPROVALS_BOARD_ID}, url: ${JSON.stringify(hookUrl)}, event: change_status_column_value, config: ${cfg}) { id } }`,
    );
    const createdId = (createRes.data?.create_webhook as { id?: string } | undefined)?.id;
    if (createRes.error || !createdId) {
      return ok({
        ok: false,
        error: `create_webhook failed: ${createRes.error ?? "no id returned"}`,
      });
    }
    const registry = Array.isArray(sRow?.monday_webhooks)
      ? [...(sRow.monday_webhooks as unknown[])]
      : [];
    registry.push({
      event: "change_status_column_value",
      board_id: APPROVALS_BOARD_ID,
      webhook_id: String(createdId),
      registered_at: new Date().toISOString(),
      purpose: "nightly-approvals-decision",
    });
    await admin
      .from("system_settings")
      .update({ monday_webhooks: registry })
      .eq("id", (sRow as { id: unknown }).id);
    return ok({ ok: true, created: String(createdId) });
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
    // No text for dispo outcomes — a "needs review" or an "error" both live in
    // the Close Kombat → Dispo "Needs review" list now (owner mandate 2026-10-07:
    // only a sale / no-show-at-door / uncovered-lead texts the phone). The
    // Dispatcher column stamp above already flags it for the office at a glance.
  };

  // Hoisted so the catch-all error row still carries rep + lead detail (never a
  // bare form id). Filled in once the form is parsed.
  let baseRow: Record<string, unknown> = {};

  try {
    // ── settings ──────────────────────────────────────────────────────────
    const { data: settings } = await supabase
      .from("system_settings")
      // select("*") on purpose: a narrow list naming a not-yet-migrated column
      // (dispatch_pairing) would fail the WHOLE read and stall the live write-back
      // if the function deploys before the migration. One row; same as
      // monday-live-dispatch.
      .select("*")
      .maybeSingle();
    const token = ((settings?.monday_api_token as string | null) ?? "").trim();
    oohToken = token || null;
    const mode = (settings?.ooh_writeback_mode as string | null) ?? "off";
    const dispatchMode = ((settings?.live_dispatch_mode as string | null) ?? "off") as
      "off" | "dry_run" | "live";
    // Rule 8: the hot-reps / hot-pairs roster the owner tunes in settings (the
    // Close Kombat / pairing analytics drop straight in — no code change).
    const dispatchCfg = withPairing(
      (settings?.dispatch_pairing as DispatchPairingOverride | null) ?? null,
    );
    const activeSd = (settings?.active_monday_board_sd as string | null) ?? null;
    const activeOc = (settings?.active_monday_board_oc as string | null) ?? null;
    // Auto-create a line item on THIS week's block when a report can't land on
    // the current block (a no-lead-id self-gen/upsell/reload, OR a matched lead
    // sitting on an older block) — owner directive 2026-10-07. Hoisted here so
    // both the create-target path and the old-block matched path can read it.
    const autocreate = (settings?.ooh_autocreate as boolean | null) ?? false;
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

    // Rule 3: the Monday user the dispatcher writes AS (excluded from the
    // human-touch guard). Resolved once, only when dispatch will run.
    const dispatcherUserId =
      dispatchMode !== "off" ? await fetchMondayMe(token).catch(() => null) : null;

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
    baseRow = buildBaseQueueRow(form, detailsLine, plan, { customerName: formItem.name || null });

    // ── Rule 16a: the second partner's copy ─────────────────────────────────
    // A report for a customer whose report we ALREADY processed today (the
    // partner filed first) → auto-mark Handled, write NOTHING. We stamp every
    // processed report with a customer+day+address key and dedupe on it, so
    // these never pile up in Needs Review.
    const custKey = customerDayKey(
      formItem.name,
      form.apptDate?.date ?? laDate(formItem.createdAtMs),
      form.address,
    );
    if (custKey) {
      await supabase
        .from("ooh_processed_reports")
        .update({ customer_key: custKey })
        .eq("form_item_id", formItemId);
      const { data: sib } = await supabase
        .from("ooh_processed_reports")
        .select("form_item_id")
        .eq("customer_key", custKey)
        .neq("form_item_id", formItemId)
        .in("outcome", ["written", "created", "duplicate", "processed"])
        .limit(1);
      if ((sib?.length ?? 0) > 0) {
        await finish("duplicate");
        await supabase.from("ooh_report_queue").upsert(
          {
            form_item_id: formItemId,
            status: "processed",
            reason: "duplicate — partner's copy; same customer already processed today",
            ...baseRow,
          },
          { onConflict: "form_item_id" },
        );
        await stampDispatcher(DISPATCHER_LABEL.processed);
        return ok({ duplicatePartnerCopy: custKey });
      }
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

    // ── Resolve the block item to write to ──────────────────────────────────
    // Lead ID → that item. No Lead ID + on-block → match it to today's block
    // day-group (owner brief Part 1). Self-gen / upsell / reload → create a line
    // item on THIS week's block when auto-create is on (owner directive
    // 2026-10-07; office inferred from the rep's attendance), else queue it.
    let leadId: string;
    if (target.kind === "write") {
      leadId = form.leadId!;
    } else if (target.kind === "create") {
      if (autocreate && mode === "live") {
        const weekday = weekdayOfDate(form.apptDate?.date, formItem.createdAtMs);
        const [sdNames, ocNames] = await Promise.all([
          fetchAttendance(token, "SD", weekday)
            .then((m) => new Set(m.keys()))
            .catch(() => new Set<string>()),
          fetchAttendance(token, "OC", weekday)
            .then((m) => new Set(m.keys()))
            .catch(() => new Set<string>()),
        ]);
        const createOffice = inferCreateOffice({
          oldBlockOffice: null,
          repName: form.repName,
          partner: form.partner,
          sdFirstNames: sdNames,
          ocFirstNames: ocNames,
        });
        const createBoard =
          createOffice === "SD" ? activeSd : createOffice === "OC" ? activeOc : null;
        if (createOffice && createBoard) {
          mondayTouched = true;
          const res = await runAutoCreate({
            token,
            supabase,
            office: createOffice,
            currentBoardId: createBoard,
            groupId: blockDayGroupForAppt(form.apptDate, formItem.createdAtMs),
            form,
            formItem,
            plan,
            oldBlockSource: null,
            dispatchMode,
            formItemId,
            alertSale: () => alertSaleOnce(formItem.name || form.address),
            cfg: dispatchCfg,
            dispatcherUserId,
          });
          if (res.ok) {
            await stampDispatcher(DISPATCHER_LABEL.processed);
            await finish("created", { target_item_id: res.itemId, board_id: createBoard });
            return ok({ created: res.itemId, office: createOffice });
          }
          await finish("error");
          await queue("error", `auto-create failed: ${res.error}`, {
            ...baseRow,
            error: res.error,
          });
          return ok({ error: res.error });
        }
        // Office couldn't be resolved → don't guess; send to review (owner rule).
        await finish("queued");
        const saleRes = await alertSaleOnce(formItem.name || form.address);
        const ste = saleTextError(saleRes);
        await queue(
          "needs_review",
          `auto-create: couldn't resolve office for ${form.repName ?? "rep"} — ${target.reason}`,
          { ...baseRow, ...(ste ? { error: ste } : {}) },
        );
        return ok({ queued: "auto-create office unresolved" });
      }
      // auto-create off (or write-back not live) → queue + text the sale now.
      await finish("queued");
      const saleRes = await alertSaleOnce(formItem.name || form.address); // self-gen SALE → text now
      const ste = saleTextError(saleRes);
      await queue("needs_review", `auto-create off — ${target.reason}`, {
        ...baseRow,
        ...(ste ? { error: ste } : {}),
      });
      return ok({ queued: "create (auto-create off)" });
    } else if (target.kind === "match") {
      // Owner brief Part 1: no Lead ID — match the submission to a block item on
      // today's day-group across BOTH offices' current boards, by normalized
      // address first, then customer last name + rep. Queue for review only on
      // 0 or 2+ candidates (never guess between two leads).
      const weekday = matchWeekday(form.apptDate, formItem.createdAtMs);
      const groupId = BLOCK_DAY_GROUP[weekday];
      const seen = new Set<string>();
      const candidates: MatchCandidate[] = [];
      for (const b of [activeSd, activeOc].filter((x): x is string => !!x)) {
        const cs = await fetchMatchCandidates(token, b, groupId).catch(
          () => [] as MatchCandidate[],
        );
        for (const c of cs)
          if (!seen.has(c.id)) {
            seen.add(c.id);
            candidates.push(c);
          }
      }
      const m = matchWithoutLeadId({
        address: form.address,
        customerName: formItem.name || null,
        rep: form.repName,
        candidates,
      });
      if (m.kind === "review") {
        await finish("queued");
        await queue("needs_review", `no Lead ID — ${m.reason}`, baseRow);
        return ok({ queued: `no lead id match: ${m.reason}` });
      }
      console.log(`[ooh] matched ${formItemId} → ${m.id} by ${m.by}`);
      leadId = m.id;
    } else {
      // matchTarget no longer returns "queue" — safety net only.
      await finish("queued");
      await queue("needs_review", target.reason, baseRow);
      return ok({ queued: target.reason });
    }

    // ── fetch + gate the matched block ──────────────────────────────────────
    const block = await fetchBlockItem(token, leadId);
    if (!block || block.state !== "active") {
      await finish("queued");
      await queue("needs_review", "Lead ID not found or inactive on any block", {
        ...baseRow,
        target_item_id: leadId,
      });
      return ok({ queued: "lead not found" });
    }

    // Rule 16b: the card was already routed to a destination board (Sales
    // Processing / Rehash / Blowout / Confirmed) by its own automation → already
    // handled. Mark Processed, write NOTHING (never re-route a routed card).
    if (isHandledDestinationBoard(block.boardId)) {
      await finish("duplicate", { target_item_id: leadId, board_id: block.boardId });
      await supabase.from("ooh_report_queue").upsert(
        {
          form_item_id: formItemId,
          status: "processed",
          reason:
            "already routed to a destination board (Sales Processing / Rehash / Blowout / Confirmed)",
          ...baseRow,
          target_item_id: leadId,
          board_id: block.boardId,
        },
        { onConflict: "form_item_id" },
      );
      await stampDispatcher(DISPATCHER_LABEL.processed);
      return ok({ handledDestination: block.boardId });
    }

    // Duplicate guard (#3 / owner brief Part 5): the block already carries a
    // result — the partner reported first, or another rep named the same
    // customer — so this report is a DUPLICATE. Mark it Processed as a duplicate
    // and write NOTHING; a lead can never be routed twice. (The at-the-door
    // "No show text" marker doesn't count; the lead is still open.)
    if (hasExistingDisposition(block)) {
      await finish("duplicate", { target_item_id: leadId, board_id: block.boardId });
      await supabase.from("ooh_report_queue").upsert(
        {
          form_item_id: formItemId,
          status: "processed",
          reason: "duplicate — block already has a result",
          ...baseRow,
          target_item_id: leadId,
          board_id: block.boardId,
        },
        { onConflict: "form_item_id" },
      );
      await stampDispatcher(DISPATCHER_LABEL.processed);
      return ok({ duplicate: leadId });
    }

    // Owner brief Part 3: a block item whose Iss = "Office Appt" (job walk /
    // can-save / office appointment) keeps its own flow — the result goes to
    // Details ONLY (never PM / Reset / OL / No Demo / BO); a SALE on it sets
    // Advantage+ + Reloads then presses status9 = Reload (never Sold). Every
    // other lead uses the normal disposition plan.
    const officeAppt = isOfficeApptStatus(block.iss);
    const wplan = officeAppt ? planOfficeApptDisposition(form) : plan;

    // A normal plan the engine refuses to auto-apply (a reset result with no
    // reset date) goes to the office — press nothing (#4). Office-appt plans
    // never need review (Details only, or a Reload).
    if (wplan.needsReview) {
      await finish("queued", { target_item_id: leadId, board_id: block.boardId });
      await queue("needs_review", wplan.needsReview, {
        ...baseRow,
        target_item_id: leadId,
        board_id: block.boardId,
      });
      return ok({ queued: wplan.needsReview });
    }

    const isCurrentBlock = block.boardId === activeSd || block.boardId === activeOc;
    const liveAllowed = mode === "live" && allowedBoards.has(block.boardId);
    // Which office this block belongs to, by board (authoritative — the board
    // decides which columns physically exist). Drives the office-specific Source
    // Code column id (SD and OC use different ids) and live issuing below.
    const office: "SD" | "OC" | null = isCurrentBlock
      ? block.boardId === activeSd
        ? "SD"
        : "OC"
      : null;

    // Details (Rule 3 / #6): rebuild now that the block is known, so a blank
    // arrival time falls back to the appointment time (date9, PT).
    const apptFallback =
      block.apptWallMinutes != null
        ? { hour: Math.floor(block.apptWallMinutes / 60), minute: block.apptWallMinutes % 60 }
        : null;
    const detailsLineForBlock = buildDetailsLine(form, formItem.createdAtMs, apptFallback);

    // Source Code fill (Rule 4), computed against the block's live values.
    const fieldWrites: Record<string, unknown> = { ...wplan.fieldWrites };
    let sourceCodeNote = "";
    if (wplan.fillSourceCodeIfBlank) {
      const { code, unknownSource } = sourceCodeToWrite(
        form.result,
        block.sourceCode,
        block.source,
      );
      // Write to the OFFICE-appropriate Source Code column — the SD and OC
      // boards use different ids, so the single hardcoded id dropped every OC
      // sale's code onto a non-existent column (never reached Sales Processing).
      if (code != null) fieldWrites[sourceCodeColId(office)] = String(code);
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

    const rowWithTarget = {
      ...baseRow,
      details_line: detailsLineForBlock,
      target_item_id: leadId,
      board_id: block.boardId,
      office,
    };

    // Reps this report frees (the submitter + their partner, if any).
    const freedReps = [form.repName, form.partner].filter((r): r is string => !!r && !!r.trim());
    const resultLabel = (wplan.status?.label ?? null) as string | null;

    // Matched lead sitting on an OLDER block (not this week's) → add a fresh line
    // item to THIS week's block and result it there, just like a self-gen (owner
    // directive 2026-10-07). Reuses the old card's office. The already-
    // dispositioned guard above already skipped handled cards, so this never
    // re-creates a lead the office closed.
    if (!isCurrentBlock && autocreate && mode === "live") {
      const createOffice = block.office;
      const createBoard =
        createOffice === "SD" ? activeSd : createOffice === "OC" ? activeOc : null;
      if (createOffice && createBoard) {
        mondayTouched = true;
        const res = await runAutoCreate({
          token,
          supabase,
          office: createOffice,
          currentBoardId: createBoard,
          groupId: blockDayGroupForAppt(form.apptDate, formItem.createdAtMs),
          form,
          formItem,
          plan,
          oldBlockSource: block.source,
          dispatchMode,
          formItemId,
          alertSale: () => alertSaleOnce(block.name),
          cfg: dispatchCfg,
          dispatcherUserId,
        });
        if (res.ok) {
          await stampDispatcher(DISPATCHER_LABEL.processed);
          await finish("created", { target_item_id: res.itemId, board_id: createBoard });
          return ok({ created: res.itemId, movedFrom: block.boardId, office: createOffice });
        }
        await finish("error");
        await queue("error", `auto-create to current block failed: ${res.error}`, {
          ...rowWithTarget,
          error: res.error,
        });
        return ok({ error: res.error });
      }
      // Office unreadable on the old card → fall through to the review queue.
    }

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
      if (dispatchMode !== "off" && office && !wplan.atTheDoor) {
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
          cfg: dispatchCfg,
          dispatcherUserId,
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
    // Rule 11 (owner 2026-10-08): Advantage+ is a BUTTON — its own press, after
    // the columns write and BEFORE the result button. Never a column note.
    if (wplan.advantageStatus) {
      const rA = await setStatus(
        token,
        block.boardId,
        leadId,
        wplan.advantageStatus.col,
        wplan.advantageStatus.label,
        `ooh-advantage-${formItemId}`,
      );
      if (rA.error) throw new Error(`setStatus(Advantage+): ${rA.error}`);
      await logDispatchWrite(supabase, {
        mode: "live",
        trigger: "report",
        formItemId,
        boardId: block.boardId,
        itemId: leadId,
        leadName: block.name,
        columnId: wplan.advantageStatus.col,
        columnLabel: "Advantage+",
        oldValue: null,
        newValue: wplan.advantageStatus.label,
        reason: `dispo report from ${form.repName ?? "rep"}`,
      });
    }
    if (wplan.status) {
      const r2 = await setStatus(
        token,
        block.boardId,
        leadId,
        wplan.status.col,
        wplan.status.label,
        `ooh-status-${formItemId}`,
      );
      if (r2.error) throw new Error(`setStatus: ${r2.error}`);
      // Rule 21: audit the disposition status press (old → new).
      const oldByCol: Record<string, string | null> = {
        [BLOCK_COL.pm]: block.pm,
        [BLOCK_COL.rs]: block.rs,
        [BLOCK_COL.ol]: block.ol,
        [BLOCK_COL.bo]: block.bo,
        [BLOCK_COL.sale]: block.sale,
        [BLOCK_COL.iss]: block.iss,
      };
      await logDispatchWrite(supabase, {
        mode: "live",
        trigger: "report",
        formItemId,
        boardId: block.boardId,
        itemId: leadId,
        leadName: block.name,
        columnId: wplan.status.col,
        columnLabel: null,
        oldValue: oldByCol[wplan.status.col] ?? null,
        newValue: wplan.status.label,
        reason: `dispo report from ${form.repName ?? "rep"}`,
      });
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

    // Rule 13: a Sold routes to Sales Processing — remember the deposit /
    // finance / Advantage+ / reloads to fill on the moved card (the SP-board
    // webhook pointed at ?task=sales-processing completes it), and try an
    // immediate fill in case the automation already moved the card.
    if (wplan.status?.col === BLOCK_COL.sale) {
      const spValues = planSalesProcessingWrite(form);
      if (Object.keys(spValues).length > 0) {
        await supabase
          .from("ooh_sales_processing_pending")
          .upsert(
            {
              form_item_id: formItemId,
              customer_key: customerDayKey(
                block.name,
                form.apptDate?.date ?? laDate(formItem.createdAtMs),
                form.address,
              ),
              customer_name: block.name,
              board_id: block.boardId,
              values: spValues,
            },
            { onConflict: "form_item_id" },
          )
          .then(
            () => undefined,
            () => undefined,
          );
        const spId = await findItemOnBoardByName(
          token,
          DESTINATION_BOARDS.salesProcessing,
          block.name,
        ).catch(() => null);
        if (spId)
          await fillSalesProcessingForItem(token, supabase, spId, block.name).catch(
            () => undefined,
          );
      }
    }

    // ── Rule 6 / owner brief Part 2: at-the-door → message the managers; issue
    // nothing (the rep is still waiting at the door). ────────────────────────
    let released: string | null = null;
    if (wplan.atTheDoor) {
      await sendDispatcherIMessage(
        buildNoShowAtDoorText(block.name, laClock(formItem.createdAtMs), form.repName),
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
        cfg: dispatchCfg,
        dispatcherUserId,
      }).catch((e) => {
        console.error("[ooh dispatch]", e instanceof Error ? e.message : e);
        return null;
      });
    }

    await finish("written", { target_item_id: leadId, board_id: block.boardId });
    return ok({
      written: leadId,
      status: wplan.status?.label ?? null,
      released,
      atTheDoor: wplan.atTheDoor,
      officeAppt,
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
// dispatch.ts; this does the Monday reads/writes + the decision log. In 'live'
// it writes people6 then Iss (firing Monday's own "New Opportunity!" text,
// which is how the REP learns — the dispatcher phone is NOT texted for a
// routine issue); in 'dry_run' it only computes and logs. Returns the issued
// lead id (live only), else null. Never throws past the caller's catch — a
// dispatch failure must never undo the write-back.
//
// Text noise (owner mandate 2026-10-07): a routine "Issued:", a "[DRY RUN] would
// issue", and the "Free reps" tail no longer text anyone — they live only in the
// decision log. The two cases a human must act on — a lead the dispatcher could
// NOT auto-issue (couldn't match the rep to a Monday user, or the write failed)
// and a lead the rules send to a manager (language request / orphan job walk) —
// are surfaced in the Close Kombat → Dispo "Needs review" list instead of a text
// (live mode only; a dry-run rehearsal writes nothing, not even a queue row).
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
  cfg: typeof import("./dispatch.ts").DISPATCH_CONFIG;
  dispatcherUserId: string | null;
}): Promise<string | null> {
  if (p.repNames.length === 0) return null;
  const weekday = laWeekday(p.nowMs);
  const nowWall = nowWallMinutes(p.nowMs);
  const todayLA = laDate(p.nowMs);

  const [attendance, dayItems, users] = await Promise.all([
    fetchAttendance(p.token, p.office, weekday).catch(() => new Map()),
    fetchDispatchDayItems(p.token, p.block.boardId, p.block.groupId).catch(() => []),
    fetchMondayUsers(p.token).catch(() => [] as Array<{ id: string; name: string }>),
  ]);
  await enrichHistory(p.supabase, dayItems).catch(() => undefined);

  // Working / free reps across the office (Rule 8 — the pool a must-pair rep's
  // partner is drawn from). Open-lead count excludes the just-reported lead.
  const openLeadsFor = (name: string) =>
    dayItems.filter(
      (l) =>
        l.itemId !== p.reportedLeadId &&
        l.reps.map(normName).includes(normName(name)) &&
        isOpenLead({ iss: l.issLabel, pm: l.pm, rs: l.rs, ol: l.ol, bo: l.bo, sale: l.sale }),
    ).length;
  const workingReps: DispatchRep[] = [];
  for (const [name, att] of attendance as Map<
    string,
    { amOn: boolean; pmOn: boolean; amOff: boolean; pmOff: boolean }
  >) {
    if (!(att.amOn || att.pmOn)) continue;
    const off = att.amOff && att.pmOff && !att.amOn && !att.pmOn;
    workingReps.push({
      name,
      office: p.office,
      working: true,
      off,
      openLeadCount: openLeadsFor(name),
      lastCoords: null,
    });
  }
  const freeReps = workingReps.filter(isFreeRep);

  // Rule 3: has a HUMAN (not the dispatcher) changed people6 / Iss on this lead
  // today? The window is the last 24h; the pure predicate filters to today (LA).
  // Best-effort read failure → don't block (Rule 1's additive write still keeps
  // any manager's rep). Only relevant to a live write.
  const guardBlocked = async (leadItemId: string, boardId: string): Promise<boolean> => {
    if (p.mode !== "live") return false;
    try {
      const logs = await fetchItemActivity(
        p.token,
        boardId,
        leadItemId,
        new Date(p.nowMs - 86_400_000).toISOString(),
        new Date(p.nowMs).toISOString(),
      );
      return humanTouchedGuardedColsToday({
        logs,
        dispatcherUserId: p.dispatcherUserId,
        todayLA,
        guardedColumnIds: GUARDED_WRITE_COLS,
      });
    } catch {
      return false;
    }
  };

  const chosen = new Set<string>(); // never issue the same lead to both partners
  let issued: string | null = null;

  // A dispatch exception the office must handle by hand → the "Needs review"
  // list (ooh_report_queue), not a text. Keyed by a synthetic form_item_id per
  // lead so repeated failures update one row instead of piling up; cleared when
  // the lead is later issued cleanly. Live mode only — a dry-run writes nothing.
  const dispatchReviewKey = (leadItemId: string) => `dispatch-${leadItemId}`;
  const queueDispatchReview = async (v: {
    leadItemId: string;
    leadName: string | null;
    boardId: string;
    repName: string | null;
    reason: string;
  }): Promise<void> => {
    if (p.mode !== "live") return;
    try {
      await p.supabase.from("ooh_report_queue").upsert(
        {
          form_item_id: dispatchReviewKey(v.leadItemId),
          status: "needs_review",
          reason: v.reason,
          rep_name: v.repName,
          office: p.office,
          board_id: v.boardId,
          target_item_id: v.leadItemId,
          lead_id: v.leadItemId,
          raw: { customerName: v.leadName, apptLabel: null },
        },
        { onConflict: "form_item_id" },
      );
    } catch {
      /* best-effort — a queue hiccup must never undo the write-back */
    }
  };
  const clearDispatchReview = async (leadItemId: string): Promise<void> => {
    if (p.mode !== "live") return;
    try {
      await p.supabase
        .from("ooh_report_queue")
        .delete()
        .eq("form_item_id", dispatchReviewKey(leadItemId));
    } catch {
      /* best-effort */
    }
  };

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
    const plan = planIssue({ rep, dayLeads: pool, nowWallMinutes: nowWall, cfg: p.cfg });

    if (plan.action === "issue") {
      chosen.add(plan.lead.itemId);
      let didIssue = false;
      let failReason: string | null = null;

      // ── Rule 8: two reps unless the rep is hot (Daniel never alone) ────────
      // When the rep can't go solo and the lead carries no partner yet, pick a
      // free partner to ADD (never replace). No partner available → withhold for
      // a manager; never issue the rep alone.
      let partnerName: string | null = null;
      let soloFallback = false;
      if (mustPair(repName, p.cfg)) {
        const existingPartners = plan.lead.reps
          .map(normName)
          .filter((n) => n && n !== normName(repName));
        if (existingPartners.length === 0) {
          const partner = choosePartner({
            rep,
            lead: plan.lead,
            freeReps: freeReps.filter((fr) => firstName(fr.name) !== firstName(repName)),
            cfg: p.cfg,
          });
          if (partner) partnerName = partner.name;
          else if (!isNeverSolo(repName, p.cfg)) {
            // Soft tier (owner, 2026-10-08 pm): "pair whenever possible" reps
            // (Jaxon / Garett) go SOLO when nobody is free — proceed; the issue
            // decision below carries the note. Only neverSolo (Daniel) is
            // withheld for a manager.
            soloFallback = true;
          } else {
            chosen.delete(plan.lead.itemId);
            await queueDispatchReview({
              leadItemId: plan.lead.itemId,
              leadName: plan.lead.name,
              boardId: plan.lead.boardId,
              repName,
              reason: `${repName} can't run solo and no partner is free — assign a partner (Rule 8).`,
            });
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
              score: plan.score,
              driveMinutes: plan.driveMinutes,
              strength: plan.strength,
              reason: `needs a partner (Rule 8): ${plan.reason}`,
              issued: false,
            });
            continue;
          }
        }
      }

      if (p.mode === "live") {
        const uid = resolveUserId(users, repName);
        if (!uid) {
          failReason = `couldn't match ${repName} to a Monday user`;
        } else if (!plan.addRep && (await guardBlocked(plan.lead.itemId, plan.lead.boardId))) {
          // (An "Add Rep" lead is exempt from the guard: the manager setting
          // Add Rep today IS the request to add a rep, the people6 write is a
          // pure union, and the status is never touched on these.)
          // Rule 3/4: a human changed people6 or Iss on this lead today — never
          // touch it again (the Langley 3:30 fix). A protective SKIP, not a
          // failure: no needs-review row, just the decision log.
          chosen.delete(plan.lead.itemId);
          await logDispatchDecision(p.supabase, {
            mode: p.mode,
            trigger: "report",
            formItemId: p.formItemId,
            repName,
            office: p.office,
            boardId: plan.lead.boardId,
            leadItemId: plan.lead.itemId,
            leadName: plan.lead.name,
            action: "none",
            score: plan.score,
            driveMinutes: plan.driveMinutes,
            strength: plan.strength,
            reason: "skipped — a human changed people6/Iss on this lead today (Rule 3)",
            issued: false,
          });
          continue;
        } else {
          const partnerUid = partnerName
            ? (resolveUserId(users, partnerName) ?? resolveUserIdByFirstName(users, partnerName))
            : null;
          // ── Rule 1: people6 is ADDITIVE ──────────────────────────────────
          // Union the reps already on the lead with the issued rep (+ partner);
          // never drop anyone a manager put there (the Langley Jaxon+Edward fix).
          const existingIds = await fetchPeopleColumnIds(
            p.token,
            plan.lead.itemId,
            BLOCK_COL.reps,
          ).catch(() => [] as string[]);
          const merged = mergePeople(existingIds, [uid, ...(partnerUid ? [partnerUid] : [])]);
          const r1 = await setPeopleColumn(
            p.token,
            plan.lead.boardId,
            plan.lead.itemId,
            BLOCK_COL.reps,
            merged,
            `ooh-people-${plan.lead.itemId}`,
          );
          if (r1.error) failReason = `people6: ${r1.error}`;
          else {
            // Rule 21: audit the people6 write (old → new).
            await logDispatchWrite(p.supabase, {
              mode: p.mode,
              trigger: "report",
              formItemId: p.formItemId,
              boardId: plan.lead.boardId,
              itemId: plan.lead.itemId,
              leadName: plan.lead.name,
              columnId: BLOCK_COL.reps,
              columnLabel: "Reps",
              oldValue: existingIds.join(","),
              newValue: merged.join(","),
              reason: plan.reason,
            });
            if (plan.addRep) {
              // #3 "Add Rep": the people6 ADD above is the whole job — the
              // lead keeps its current rep AND its status (never pressed).
              didIssue = true;
              issued = plan.lead.itemId;
            } else {
              // Owner brief Part 4: the rep's OWN job walk is pressed "Office
              // Appt" (keeps its own flow), everything else "Iss".
              const issLabel = issLabelForLead(plan.lead);
              const r2 = await setStatus(
                p.token,
                plan.lead.boardId,
                plan.lead.itemId,
                BLOCK_COL.iss,
                issLabel,
                `ooh-iss-${plan.lead.itemId}`,
              );
              if (r2.error) failReason = `Iss: ${r2.error}`;
              else {
                await logDispatchWrite(p.supabase, {
                  mode: p.mode,
                  trigger: "report",
                  formItemId: p.formItemId,
                  boardId: plan.lead.boardId,
                  itemId: plan.lead.itemId,
                  leadName: plan.lead.name,
                  columnId: BLOCK_COL.iss,
                  columnLabel: "Iss",
                  oldValue: plan.lead.issLabel ?? null,
                  newValue: issLabel,
                  reason: plan.reason,
                });
                didIssue = true;
                issued = plan.lead.itemId;
              }
            }
          }
        }
      }
      if (failReason) {
        // Couldn't auto-issue (no Monday user match / write failed) → the office
        // assigns by hand. Surface it in the Needs review list, not a text.
        await queueDispatchReview({
          leadItemId: plan.lead.itemId,
          leadName: plan.lead.name,
          boardId: plan.lead.boardId,
          repName,
          reason: `Couldn't auto-issue to ${repName}: ${failReason}. Assign by hand.`,
        });
      } else if (didIssue) {
        // Routine issue — the rep already gets Monday's "New Opportunity!" text;
        // no dispatcher text. Clear any stale needs-review row for this lead.
        await clearDispatchReview(plan.lead.itemId);
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
        reason:
          failReason ??
          (partnerName
            ? `${plan.reason} (+ partner ${partnerName})`
            : soloFallback
              ? `${plan.reason} (no partner free — solo fallback)`
              : plan.reason),
        issued: didIssue,
      });
    } else if (plan.action === "manager") {
      // The rules withhold this lead for a human (language request / orphan job
      // walk) → Needs review list, not a text. No rep_name: the office picks who.
      await queueDispatchReview({
        leadItemId: plan.lead.itemId,
        leadName: plan.lead.name,
        boardId: plan.lead.boardId,
        repName: null,
        reason: `Managers assign: ${plan.reason}.`,
      });
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
      // Rep had no eligible lead (a "free rep") → decision log only. The owner
      // explicitly cut the "Free reps" text (2026-10-07); it's visible in the
      // decision log, and a truly uncovered lead is still caught by the watchdog.
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

  return issued;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-CREATE — add a line item to THIS week's block and result it there, for a
// report that can't land on the current block: a no-lead-id self-gen/upsell/
// reload, or a matched lead sitting on an older block (owner directive
// 2026-10-07 — "we add the line item to this week's block, just like a self-gen").
// Mirrors the matched-lead write: non-status columns FIRST, then the ONE
// disposition status in a SEPARATE call, so the block's "status changes"
// automations fire and route it (Sold → Sales Processing, etc.). Then the SALE
// text and live issuing, same as a matched sale. Never throws past the caller's
// catch — the create + status are checked, the rest is best-effort.
// ═══════════════════════════════════════════════════════════════════════════
async function runAutoCreate(p: {
  token: string;
  supabase: Supa;
  office: "SD" | "OC";
  currentBoardId: string;
  groupId: string;
  form: ReturnType<typeof parseOohForm>;
  formItem: FormItem;
  plan: WritePlan;
  oldBlockSource: string | null;
  dispatchMode: "off" | "dry_run" | "live";
  formItemId: string;
  alertSale: () => Promise<InkboxResult | null>;
  cfg: typeof import("./dispatch.ts").DISPATCH_CONFIG;
  dispatcherUserId: string | null;
}): Promise<{ ok: true; itemId: string } | { ok: false; error: string }> {
  const name = (p.formItem.name || p.form.address || "OOH report").slice(0, 255);
  const detailsLine = buildDetailsLine(p.form, p.formItem.createdAtMs);
  const sourceText = createSourceText(p.form, p.oldBlockSource);

  // Non-status columns. The disposition status is pressed SEPARATELY below so
  // Monday's "status changes" automations fire (creating with a preset status
  // would not route the card).
  const cols: Record<string, unknown> = { ...p.plan.fieldWrites };
  cols[BLOCK_COL.office] = { label: OFFICE_LABEL[p.office] };
  if (p.form.apptDate)
    cols[BLOCK_COL.apptDateTime] = {
      date: p.form.apptDate.date,
      ...(p.form.apptDate.time ? { time: p.form.apptDate.time } : {}),
    };
  cols[BLOCK_COL.source] = sourceText;
  if (p.plan.fillSourceCodeIfBlank) {
    const { code } = sourceCodeToWrite(p.form.result, null, sourceText);
    if (code != null) cols[sourceCodeColId(p.office)] = String(code);
  }
  cols[BLOCK_COL.details] = { text: detailsLine };

  // Reps (people6): credit the submitter + partner so the card is attributed and
  // the live-issuer can free them. Best-effort — a name we can't resolve to a
  // Monday user is simply omitted; it never blocks the create.
  const repNames = [p.form.repName, p.form.partner].filter((r): r is string => !!r && !!r.trim());
  if (repNames.length) {
    const users = await fetchMondayUsers(p.token).catch(
      () => [] as Array<{ id: string; name: string }>,
    );
    const uids = repNames.map((r) => resolveUserId(users, r)).filter((u): u is string => !!u);
    if (uids.length)
      cols[BLOCK_COL.reps] = {
        personsAndTeams: uids.map((id) => ({ id: Number(id), kind: "person" })),
      };
  }

  const newId = await createItem(
    p.token,
    p.currentBoardId,
    p.groupId,
    name,
    cols,
    `ooh-create-${p.formItemId}`,
  );
  if (!newId) return { ok: false, error: "create_item returned no id" };

  // Rule 11: the Advantage+ BUTTON gets its own press before the result button.
  if (p.plan.advantageStatus) {
    const rA = await setStatus(
      p.token,
      p.currentBoardId,
      newId,
      p.plan.advantageStatus.col,
      p.plan.advantageStatus.label,
      `ooh-create-advantage-${p.formItemId}`,
    );
    if (rA.error) return { ok: false, error: `setStatus(Advantage+): ${rA.error}` };
    await logDispatchWrite(p.supabase, {
      mode: "live",
      trigger: "report",
      formItemId: p.formItemId,
      boardId: p.currentBoardId,
      itemId: newId,
      leadName: name,
      columnId: p.plan.advantageStatus.col,
      columnLabel: "Advantage+",
      oldValue: null,
      newValue: p.plan.advantageStatus.label,
      reason: "auto-created from OOH report",
    });
  }

  if (p.plan.status) {
    const r = await setStatus(
      p.token,
      p.currentBoardId,
      newId,
      p.plan.status.col,
      p.plan.status.label,
      `ooh-create-status-${p.formItemId}`,
    );
    if (r.error) return { ok: false, error: `setStatus: ${r.error}` };
    // Rule 21: audit the status press on the auto-created card (old = blank).
    await logDispatchWrite(p.supabase, {
      mode: "live",
      trigger: "report",
      formItemId: p.formItemId,
      boardId: p.currentBoardId,
      itemId: newId,
      leadName: name,
      columnId: p.plan.status.col,
      columnLabel: null,
      oldValue: null,
      newValue: p.plan.status.label,
      reason: "auto-created from OOH report",
    });
  }

  const formLink = `https://tidal-remodeling.monday.com/boards/${FORM_BOARD_ID}/pulses/${p.formItemId}`;
  await postUpdate(
    p.token,
    newId,
    `Auto-created from OOH report by ${p.form.repName ?? "rep"} at ${laClock(p.formItem.createdAtMs)} — ${formLink}`,
    oohUpdateKey(`create-${p.formItemId}`),
  ).catch(() => undefined);

  // SALE text — the same banner as a matched sale; a no-op for a non-sale result.
  await p.alertSale().catch(() => null);

  // Live issuing: hand the freed rep(s) their next lead, same as a matched sale.
  if (p.dispatchMode !== "off" && !p.plan.atTheDoor) {
    const syntheticBlock: BlockItem = {
      id: newId,
      name,
      state: "active",
      boardId: p.currentBoardId,
      groupId: p.groupId,
      office: p.office,
      source: sourceText,
      sourceCode: null,
      details: detailsLine,
      apptWallMinutes: null,
      reps: repNames,
      coords: null,
      iss: null,
      pm: null,
      rs: null,
      ol: null,
      bo: null,
      sale: null,
    };
    await runDispatch({
      token: p.token,
      supabase: p.supabase,
      mode: p.dispatchMode === "live" ? "live" : "dry_run",
      office: p.office,
      block: syntheticBlock,
      reportedLeadId: newId,
      reportedLeadName: name,
      reportedResultLabel: p.plan.status?.label ?? null,
      repNames,
      nowMs: p.formItem.createdAtMs,
      formItemId: p.formItemId,
      cfg: p.cfg,
      dispatcherUserId: p.dispatcherUserId,
    }).catch((e) =>
      console.error("[ooh auto-create dispatch]", e instanceof Error ? e.message : e),
    );
  }

  return { ok: true, itemId: newId };
}

// ═══════════════════════════════════════════════════════════════════════════
// Rule 13 — fill a Sales Processing card. Matches the created card (by
// normalized customer name) to an unfilled pending row stored when the Sold
// button was pressed, writes its deposit / finance / Advantage+ / reloads, and
// marks the pending row filled. Best-effort; never throws past its caller.
// ═══════════════════════════════════════════════════════════════════════════
async function fillSalesProcessingForItem(
  token: string,
  supabase: Supa,
  spItemId: string,
  spName: string,
): Promise<{ filled: boolean; reason: string }> {
  const want = normName(spName ?? "");
  if (!spItemId || !want) return { filled: false, reason: "no SP item id / name" };
  const { data: rows } = await supabase
    .from("ooh_sales_processing_pending")
    .select("form_item_id, customer_name, values")
    .is("filled_at", null)
    .order("created_at", { ascending: false })
    .limit(100);
  const match = (
    (rows as Array<{
      form_item_id: string;
      customer_name: string | null;
      values: Record<string, unknown>;
    }> | null) ?? []
  ).find((r) => normName(String(r.customer_name ?? "")) === want);
  if (!match) return { filled: false, reason: "no pending SP row for this card" };
  const values = match.values ?? {};
  if (Object.keys(values).length === 0) {
    await supabase
      .from("ooh_sales_processing_pending")
      .update({ filled_at: new Date().toISOString(), sp_item_id: spItemId })
      .eq("form_item_id", match.form_item_id);
    return { filled: true, reason: "nothing to write" };
  }
  const r = await setColumns(
    token,
    DESTINATION_BOARDS.salesProcessing,
    spItemId,
    values,
    `ooh-sp-${match.form_item_id}`,
  );
  if (r.error) return { filled: false, reason: `setColumns: ${r.error}` };
  await supabase
    .from("ooh_sales_processing_pending")
    .update({ filled_at: new Date().toISOString(), sp_item_id: spItemId })
    .eq("form_item_id", match.form_item_id);
  return { filled: true, reason: "filled" };
}
