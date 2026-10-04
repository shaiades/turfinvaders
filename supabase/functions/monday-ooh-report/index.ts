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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  fetchBlockItem,
  fetchDayGroupItems,
  fetchFormItem,
  postUpdate,
  setColumns,
  setStatus,
} from "./monday.ts";
import { sendDispatcherIMessage } from "./inkbox.ts";
import {
  BLOCK_COL,
  FORM_BOARD_ID,
  buildDetailsLine,
  laClock,
  matchTarget,
  parseOohForm,
  planDisposition,
  planRelease,
  sourceCodeToWrite,
} from "./engine.ts";

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

  const SUPABASE_URL = denoEnv?.get("SUPABASE_URL") ?? "";
  const SERVICE_ROLE = denoEnv?.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

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
  const queue = async (status: string, reason: string, row: Record<string, unknown>) => {
    await supabase
      .from("ooh_report_queue")
      .upsert({ form_item_id: formItemId, status, reason, ...row }, { onConflict: "form_item_id" });
    // Notify the office for anything that needs a human (best-effort).
    if (status === "needs_review" || status === "error") {
      await sendDispatcherIMessage(
        `OOH report needs review: ${String(row.rep_name ?? "?")}, result ${String(row.result ?? "?")}. Open Close Kombat → OOH.`,
      ).catch(() => undefined);
    }
  };

  try {
    // ── settings ──────────────────────────────────────────────────────────
    const { data: settings } = await supabase
      .from("system_settings")
      .select(
        "monday_api_token, active_monday_board_sd, active_monday_board_oc, ooh_writeback_mode, ooh_writeback_board_allowlist, ooh_autocreate",
      )
      .maybeSingle();
    const token = ((settings?.monday_api_token as string | null) ?? "").trim();
    const mode = (settings?.ooh_writeback_mode as string | null) ?? "off";
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
    const detailsLine = buildDetailsLine(form, formItem.createdAtMs);
    const formLink = `https://tidal-remodeling.monday.com/boards/${FORM_BOARD_ID}/pulses/${formItemId}`;
    const baseRow: Record<string, unknown> = {
      rep_name: form.repName,
      partner: form.partner,
      result: form.result,
      on_block: form.onBlock,
      lead_id: form.leadId,
      details_line: detailsLine,
      plan: plan as unknown,
      raw: form as unknown,
    };

    // Only the matched-lead path writes automatically. Create (self-gen /
    // upsell / reload) is queued unless auto-create is explicitly enabled.
    if (target.kind !== "write") {
      const autocreate = (settings?.ooh_autocreate as boolean | null) ?? false;
      if (target.kind === "create" && !autocreate) {
        await finish("queued");
        await queue("needs_review", `auto-create off — ${target.reason}`, baseRow);
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
    const isCurrentBlock = block.boardId === activeSd || block.boardId === activeOc;
    const liveAllowed = mode === "live" && allowedBoards.has(block.boardId);

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
      ? `${block.details.trim()}\n${detailsLine}`
      : detailsLine;
    const columnValues: Record<string, unknown> = {
      ...fieldWrites,
      [BLOCK_COL.details]: { text: combinedDetails },
    };

    const rowWithTarget = {
      ...baseRow,
      target_item_id: leadId,
      board_id: block.boardId,
      office: isCurrentBlock ? (block.boardId === activeSd ? "SD" : "OC") : null,
    };

    if (!liveAllowed) {
      // dry-run / not allow-listed: store the plan, write nothing.
      await finish("dry_run", { target_item_id: leadId, board_id: block.boardId });
      await queue(
        isCurrentBlock || mode === "dry_run" ? "dry_run" : "needs_review",
        mode === "dry_run" ? "dry-run preview" : "block not allow-listed for live writes",
        rowWithTarget,
      );
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

    // Activity-log note on the block item.
    await postUpdate(
      token,
      leadId,
      `OOH report from ${form.repName ?? "rep"} at ${laClock(formItem.createdAtMs)} — ${formLink}${sourceCodeNote}`,
    ).catch(() => undefined);

    // ── Rule 6: at-the-door → message the office; release nothing ───────────
    let released: string | null = null;
    if (plan.atTheDoor) {
      await sendDispatcherIMessage(
        `No show at the door: ${block.name}, ${laClock(formItem.createdAtMs)}, ${form.repName ?? "rep"}. Office please call the lead.`,
      ).catch(() => undefined);
    } else {
      // ── Rule 7: release the rep's next lead (one lead at a time) ──────────
      const dayItems = await fetchDayGroupItems(token, block.boardId, block.groupId);
      const rel = planRelease({
        atTheDoor: false,
        rep: form.repName,
        dayItems,
        reportedLeadTimeMs: block.apptWallMinutes,
      });
      if (rel.action === "issue") {
        const r = await setStatus(
          token,
          block.boardId,
          rel.itemId,
          BLOCK_COL.iss,
          "Iss",
          `ooh-issue-${rel.itemId}`,
        );
        if (!r.error) released = rel.itemId;
      }
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
    await queue("error", msg, { form_item_id: formItemId });
    // 200 so Monday doesn't hammer redelivery; the admin queue carries the error.
    return ok({ error: msg, mondayTouched });
  }
});
