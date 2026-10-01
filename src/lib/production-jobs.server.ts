// Production-board sync engine (owner directive 2026-10-01, Weekly Action
// Plan). Walks the Monday "Production" board and mirrors the plan-relevant
// groups into public.production_jobs (+ admin-only notes into
// production_job_notes), classifies homeowner temperature at sync time, and
// Monday-notifies the project manager when a job NEWLY turns at-risk.
// A SIBLING engine on purpose (collections doctrine): a Production hiccup
// must never surface as a Close Kombat or Collections sync failure.
// Server-only: touches the service role client and the Monday token.

import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { monday } from "@/lib/monday.server";
import { addDaysISO, laTodayISO } from "@/lib/dates";
import {
  PRODUCTION_BOARD_ID,
  PRODUCTION_GROUPS,
  SCOPE_GROUP_IDS,
  buildProductionJobRow,
  classifyHomeownerNotes,
  effectiveHomeownerStatus,
  noteDateLA,
  NOTES_MAX,
  NOTES_WINDOW_DAYS,
  type HomeownerOverride,
  type NoteEntry,
  type ProductionItem,
  type ProductionJobRow,
} from "@/lib/production-jobs";
import { classifyJobTimeline } from "@/lib/action-plan";

export type ProductionSyncSummary = {
  board_id: string;
  fetched: number;
  kept: number;
  upserted: number;
  deleted: number;
  notes_fetched_for: number;
  notes_failures: number;
  geocoded: number;
  at_risk_alerts: number;
  skipped_items: Array<{ id: string; reason: string }>;
};

// Completed items stay in the mirror while the 1–7-day follow-up window
// (plus the 48h just-completed lane) can still use them.
const COMPLETED_RETENTION_DAYS = 10;

const CHUNK = 200;
const NOTES_BATCH = 25;
const GEOCODE_MAX_PER_RUN = 10;

const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TimelineValue/LocationValue/PeopleValue fragments: the row builder reads
// real dates, coordinates and Monday person ids instead of re-parsing text.
const ITEM_FIELDS =
  "cursor items { id name updated_at group { id title } column_values { id text column { title id } " +
  "... on TimelineValue { from to } ... on LocationValue { lat lng } " +
  "... on PeopleValue { persons_and_teams { id kind } } } }";

type WalkedItem = ProductionItem & { updated_at?: string | null };
type ItemsPage = { cursor: string | null; items: WalkedItem[] };

type ExistingRow = {
  monday_item_id: string;
  schedule_start: string | null;
  schedule_end: string | null;
  prev_schedule_start: string | null;
  prev_schedule_end: string | null;
  homeowner_status: ProductionJobRow["homeowner_status"];
  homeowner_status_reason: string | null;
  homeowner_status_note_date: string | null;
  lat: number | null;
  lng: number | null;
  geo_source: string | null;
  address: string | null;
};

const normAddress = (a: string): string => a.trim().toLowerCase().replace(/\s+/g, " ");

async function geocodeViaCache(
  address: string,
): Promise<{ lat: number | null; lng: number | null; fresh: boolean }> {
  const key = normAddress(address);
  const { data: hit } = await supabaseAdmin
    .from("geocode_cache")
    .select("lat, lng")
    .eq("address_norm", key)
    .maybeSingle();
  if (hit) return { lat: hit.lat, lng: hit.lng, fresh: false };

  let lat: number | null = null;
  let lng: number | null = null;
  let definitive = false; // only an OK response may be cached — a 429/5xx or
  // network blip must not become a permanent "no coordinates" (review
  // 2026-10-01); the next run retries.
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`,
      { headers: { "User-Agent": "turf-invaders/1.0 (shai@tidalremodeling.com)" } },
    );
    if (resp.ok) {
      definitive = true;
      const body = (await resp.json()) as Array<{ lat?: string; lon?: string }>;
      const first = body?.[0];
      const la = Number(first?.lat);
      const ln = Number(first?.lon);
      if (Number.isFinite(la) && Number.isFinite(ln)) {
        lat = la;
        lng = ln;
      }
    }
  } catch {
    // Geocoding is best-effort; ZIP/street fallbacks cover the gap.
  }
  if (definitive) {
    // Positive AND empty-result answers cache — one settled lookup per
    // address, ever.
    await supabaseAdmin
      .from("geocode_cache")
      .upsert([{ address_norm: key, lat, lng }], {
        onConflict: "address_norm",
        ignoreDuplicates: true,
      });
  }
  return { lat, lng, fresh: true };
}

export async function syncProductionJobs(): Promise<ProductionSyncSummary> {
  const { data: settings } = await supabaseAdmin
    .from("system_settings")
    .select("monday_api_token")
    .maybeSingle();
  const token = (settings?.monday_api_token as string | null) ?? "";
  if (!token) throw new Error("No monday_api_token in system_settings.");

  const boardId = PRODUCTION_BOARD_ID;
  const today = laTodayISO();
  const walkStartISO = new Date().toISOString();
  const skippedItems: ProductionSyncSummary["skipped_items"] = [];

  // 1) Full cursor walk (house pattern). Any page error throws — nothing is
  //    written and the delete-reconcile never runs on a partial fetch.
  const walked: WalkedItem[] = [];
  let cursor: string | null = null;
  do {
    const data: Record<string, unknown> = cursor
      ? await monday(
          token,
          `query ($cursor: String!) { next_items_page(cursor: $cursor, limit: 500) { ${ITEM_FIELDS} } }`,
          { cursor },
        )
      : await monday(
          token,
          `query ($b: ID!) { boards(ids: [$b]) { items_page(limit: 500) { ${ITEM_FIELDS} } } }`,
          { b: boardId },
        );
    const page: ItemsPage | null = cursor
      ? ((data.next_items_page as ItemsPage | null) ?? null)
      : (((data.boards as Array<{ items_page: ItemsPage }> | null) ?? [])[0]?.items_page ?? null);
    if (!page) throw new Error("items_page missing from Monday response");
    walked.push(...(page.items ?? []));
    cursor = page.cursor ?? null;
  } while (cursor);

  // 2) Scope filter: the three live groups, plus recently-Completed.
  const scopeIds = new Set(SCOPE_GROUP_IDS);
  const rows: ProductionJobRow[] = [];
  for (const item of walked) {
    const groupId = item.group?.id == null ? "" : String(item.group.id);
    if (!scopeIds.has(groupId)) continue;
    let row: ProductionJobRow;
    try {
      row = buildProductionJobRow(item, boardId);
    } catch (err) {
      skippedItems.push({
        id: String(item.id),
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (groupId === PRODUCTION_GROUPS.completed) {
      const doneISO =
        row.completion_date ??
        row.schedule_end ??
        (item.updated_at ? noteDateLA(String(item.updated_at)) : null);
      if (doneISO === null || doneISO < addDaysISO(today, -COMPLETED_RETENTION_DAYS)) continue;
    }
    rows.push(row);
  }
  const keptIds = rows.map((r) => r.monday_item_id);

  // 3) Previous state + overrides (transition detection, preserved fields).
  const existingById = new Map<string, ExistingRow>();
  for (let from = 0; ; from += 1000) {
    const { data: page, error } = await supabaseAdmin
      .from("production_jobs")
      .select(
        "monday_item_id, schedule_start, schedule_end, prev_schedule_start, prev_schedule_end, homeowner_status, homeowner_status_reason, homeowner_status_note_date, lat, lng, geo_source, address",
      )
      .order("monday_item_id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of (page ?? []) as ExistingRow[]) existingById.set(r.monday_item_id, r);
    if (!page || page.length < 1000) break;
  }

  const overridesById = new Map<string, HomeownerOverride & { set_at: string }>();
  {
    const { data: ovr, error } = await supabaseAdmin
      .from("production_job_overrides")
      .select("monday_item_id, homeowner_status, based_on_note_date, set_at");
    if (error) throw new Error(error.message);
    for (const o of ovr ?? []) {
      overridesById.set(o.monday_item_id, {
        homeowner_status: o.homeowner_status as HomeownerOverride["homeowner_status"],
        based_on_note_date: o.based_on_note_date,
        set_at: o.set_at,
      });
    }
  }

  // 4) Notes for kept items, batched. A failed batch marks its items so
  //    their previous classification is preserved — a Monday hiccup must
  //    never silently clear an at-risk flag.
  const notesByItem = new Map<string, NoteEntry[]>();
  const notesFailed = new Set<string>();
  let notesFailures = 0;
  for (const batch of chunks(keptIds, NOTES_BATCH)) {
    try {
      const data = await monday(
        token,
        `query ($ids: [ID!]) { items(ids: $ids, limit: 100) { id updates(limit: ${NOTES_MAX}) { text_body created_at creator { name } replies { text_body created_at creator { name } } } } }`,
        { ids: batch },
      );
      type RawUpdate = {
        text_body?: string | null;
        created_at?: string | null;
        creator?: { name?: string | null } | null;
        replies?: Array<{
          text_body?: string | null;
          created_at?: string | null;
          creator?: { name?: string | null } | null;
        }> | null;
      };
      const items =
        (data.items as Array<{ id: unknown; updates?: RawUpdate[] | null }> | null) ?? [];
      for (const item of items) {
        const flat: NoteEntry[] = [];
        for (const u of item.updates ?? []) {
          const pieces = [u, ...(u.replies ?? [])];
          for (const p of pieces) {
            const body = (p.text_body ?? "").trim();
            const created = p.created_at ?? null;
            if (body !== "" && created !== null) {
              flat.push({ body, created_at: created, creator: p.creator?.name ?? null });
            }
          }
        }
        flat.sort((a, b) => b.created_at.localeCompare(a.created_at));
        notesByItem.set(String(item.id), flat.slice(0, NOTES_MAX));
      }
    } catch {
      notesFailures += 1;
      for (const id of batch) notesFailed.add(id);
    }
  }

  // 5) Merge previous state, geocode gaps, classify.
  let geocoded = 0;
  for (const row of rows) {
    const prev = existingById.get(row.monday_item_id);

    // Reschedule memory: remember the last DIFFERENT schedule.
    if (prev) {
      const changed =
        prev.schedule_start !== row.schedule_start || prev.schedule_end !== row.schedule_end;
      if (changed && prev.schedule_start !== null) {
        row.prev_schedule_start = prev.schedule_start;
        row.prev_schedule_end = prev.schedule_end;
      } else {
        row.prev_schedule_start = prev.prev_schedule_start;
        row.prev_schedule_end = prev.prev_schedule_end;
      }
    }

    // Geocode: Monday gave no coordinates → cached Nominatim, bounded per
    // run (the cache makes later runs free).
    if (row.lat === null && row.address !== null) {
      if (
        prev &&
        prev.geo_source === "geocoded" &&
        prev.lat !== null &&
        prev.address !== null &&
        normAddress(prev.address) === normAddress(row.address)
      ) {
        row.lat = prev.lat;
        row.lng = prev.lng;
        row.geo_source = "geocoded";
      } else if (geocoded < GEOCODE_MAX_PER_RUN) {
        const geo = await geocodeViaCache(row.address);
        if (geo.lat !== null && geo.lng !== null) {
          row.lat = geo.lat;
          row.lng = geo.lng;
          row.geo_source = "geocoded";
        }
        if (geo.fresh) {
          geocoded += 1;
          await sleep(1100); // Nominatim politeness: ≤1 req/s
        }
      }
    }

    // Classification — or preservation when this item's notes didn't load.
    if (notesFailed.has(row.monday_item_id)) {
      if (prev) {
        row.homeowner_status = prev.homeowner_status;
        row.homeowner_status_reason = prev.homeowner_status_reason;
        row.homeowner_status_note_date = prev.homeowner_status_note_date;
      }
    } else {
      const cls = classifyHomeownerNotes(notesByItem.get(row.monday_item_id) ?? [], today);
      row.homeowner_status = cls.status;
      row.homeowner_status_reason = cls.reason;
      row.homeowner_status_note_date = cls.noteDate;
    }
  }

  // 6) Upserts (every row object carries every column — see the row builder).
  for (const batch of chunks(rows, CHUNK)) {
    const { error } = await supabaseAdmin
      .from("production_jobs")
      .upsert(batch, { onConflict: "monday_item_id" });
    if (error) throw new Error(error.message);
  }

  // 7) PM alerts — IMMEDIATELY after the jobs upsert: a later notes/
  //    reconcile failure must not skip alerts whose at_risk status is
  //    already stored (next run would read prev=at_risk and stay silent).
  //    Rules (review 2026-10-01):
  //    - Seed run (empty mirror): no alerts — everything would read as a
  //      "transition". The log row is still claimed so the episodes don't
  //      re-fire on run two.
  //    - Auto status: alert on the transition into effective at-risk,
  //      deduped per episode (the note date that flipped it).
  //    - Override to at_risk: alert once per override (set_at date) — the
  //      prev row carries the same override, so a transition check alone
  //      would never fire.
  //    - Only jobs the plan actually schedules (actionable timeline state,
  //      at least one rep) get the "recovery visit planned" wording;
  //      paused/excluded/TBD rows alert nobody.
  const seedRun = existingById.size === 0;
  let atRiskAlerts = 0;
  for (const row of rows) {
    const override = overridesById.get(row.monday_item_id);
    const next = effectiveHomeownerStatus(row, override);
    if (next.status !== "at_risk") continue;

    const timeline = classifyJobTimeline(row, today);
    const actionable = !["excluded", "paused", "upcoming_tbd"].includes(timeline.state);
    if (!actionable || row.reps.length === 0) continue;

    const episodeDate =
      next.source === "override"
        ? (noteDateLA(override?.set_at ?? "") ?? today)
        : (row.homeowner_status_note_date ?? today);

    if (next.source !== "override") {
      const prev = existingById.get(row.monday_item_id);
      // New rows (non-seed) count as transitions; an existing at_risk row
      // (auto, before any override math) means the episode already alerted.
      if (prev && prev.homeowner_status === "at_risk") continue;
    }

    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("plan_pm_alert_log")
      .upsert([{ monday_item_id: row.monday_item_id, status_note_date: episodeDate }], {
        onConflict: "monday_item_id,status_note_date",
        ignoreDuplicates: true,
      })
      .select("monday_item_id");
    if (claimErr || !claimed || claimed.length === 0) continue; // already alerted (or claim raced)
    if (seedRun) continue; // claim recorded, notification skipped

    if (row.pm_monday_ids.length === 0) {
      await supabaseAdmin.from("webhook_logs").insert({
        step: "Plan_PM_Alert_Skipped",
        data: { monday_item_id: row.monday_item_id, reason: "no PM on item" } as never,
      });
      continue;
    }
    const homeowner = row.homeowner_name ?? "A homeowner";
    const text =
      `Turf Invaders: ${homeowner} flagged at-risk from production notes` +
      `${row.homeowner_status_reason ? ` (${row.homeowner_status_reason.toLowerCase()})` : ""}. ` +
      "The rep has a recovery visit planned — please confirm status.";
    for (const pmId of row.pm_monday_ids) {
      try {
        await monday(
          token,
          "mutation ($user: ID!, $target: ID!, $text: String!) { create_notification(user_id: $user, target_id: $target, text: $text, target_type: Project) { text } }",
          { user: String(pmId), target: row.monday_item_id, text },
          { idempotencyKey: `pm-alert-${row.monday_item_id}-${episodeDate}-${pmId}` },
        );
        atRiskAlerts += 1;
      } catch (err) {
        await supabaseAdmin.from("webhook_logs").insert({
          step: "Plan_PM_Alert_Failed",
          data: {
            monday_item_id: row.monday_item_id,
            pm_monday_id: pmId,
            error: err instanceof Error ? err.message : String(err),
          } as never,
        });
      }
    }
  }

  // 8) Notes digest (admin-only table) for items whose notes loaded.
  const noteRows = keptIds
    .filter((id) => !notesFailed.has(id))
    .map((id) => ({
      monday_item_id: id,
      notes_digest: (notesByItem.get(id) ?? []) as never,
    }));
  for (const batch of chunks(noteRows, CHUNK)) {
    const { error } = await supabaseAdmin
      .from("production_job_notes")
      .upsert(batch, { onConflict: "monday_item_id" });
    if (error) throw new Error(error.message);
  }

  // 9) Reconcile deletions — only after a fully successful walk.
  const keptSet = new Set(keptIds);
  const stale: string[] = [];
  for (let from = 0; ; from += CHUNK) {
    const { data: page, error } = await supabaseAdmin
      .from("production_jobs")
      .select("monday_item_id")
      .eq("board_id", boardId)
      .lt("updated_at", walkStartISO)
      .order("monday_item_id")
      .range(from, from + CHUNK - 1);
    if (error) throw new Error(error.message);
    stale.push(...(page ?? []).map((r) => r.monday_item_id).filter((id) => !keptSet.has(id)));
    if (!page || page.length < CHUNK) break;
  }
  for (const batch of chunks(stale, CHUNK)) {
    const { error } = await supabaseAdmin
      .from("production_jobs")
      .delete()
      .in("monday_item_id", batch);
    if (error) throw new Error(error.message);
  }

  const summary: ProductionSyncSummary = {
    board_id: boardId,
    fetched: walked.length,
    kept: rows.length,
    upserted: rows.length,
    deleted: stale.length,
    notes_fetched_for: notesByItem.size,
    notes_failures: notesFailures,
    geocoded,
    at_risk_alerts: atRiskAlerts,
    skipped_items: skippedItems,
  };

  // Owner-auditable trail; the "Last updated" caption reads this step.
  await supabaseAdmin.from("webhook_logs").insert({
    step: "Production_Jobs_Synced",
    data: { today, notes_window_days: NOTES_WINDOW_DAYS, ...summary } as never,
  });

  return summary;
}
