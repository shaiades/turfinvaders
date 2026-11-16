// ═══════════════════════════════════════════════════════════════════════════
// RESPAWN WEEKLY RESET (owner ask 2026-11-13). Runs SUNDAY 12 PM PT (pg_cron →
// run_respawn_weekly_reset), right at the request deadline + attendance-week
// rollover. For BOTH Rep Attendance boards (SD 5291879937 / OC 18411800909):
//
//   1. every shift column on every rep row goes back to "On" (the reset the
//      office used to do by hand), EXCEPT
//   2. shifts granted on an APPROVED/PARTIAL recurring request
//      (respawn_recurring — "every Monday off" style) stay "Off", and
//   3. shifts granted on approved one-time requests for the COMING week
//      (respawn_requests.week_start = the new attendance week) are marked
//      "Off" — so pre-deadline approvals for next week land without the
//      manual "Sync approved → attendance" button.
//
// Rows whose "Rep status" column reads "Left" are skipped (never delete a
// rep's row — the roster column is authoritative, see the board description).
//
// Auth: x-notify-secret (shared NOTIFY_SECRET, same as the other cron tasks).
// ?force=true bypasses the system_settings.respawn_weekly_reset_enabled flag;
// ?dry_run=true computes and returns the full plan without writing Monday.
//
// Monday constants (board ids, shift → column map, On/Off labels) duplicate
// src/lib/respawn.ts — Deno can't import from src/. KEEP IN SYNC.
// ═══════════════════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type RepOffice = "SD" | "OC";

const ATTENDANCE_BOARD: Record<RepOffice, string> = {
  SD: "5291879937",
  OC: "18411800909",
};

/** shift key → attendance status column id (same ids on both office boards). */
const SHIFT_COL: Record<string, string> = {
  mon_am: "color0",
  mon_pm: "dup__of_mon_am",
  tue_am: "status",
  tue_pm: "dup__of_tuesday",
  wed_am: "dup__of_status",
  wed_pm: "dup__of_wednesday",
  thu_am: "color",
  thu_pm: "dup__of_thursday",
  fri_am: "color2",
  fri_pm: "dup__of_fri_am",
  sat_am: "color22",
  sat_pm: "dup__of_sat_am",
  sun_am: "color7",
  sun_pm: "status_mkn3rnr9",
};
const SHIFT_KEYS = Object.keys(SHIFT_COL);

/** "Rep status" roster column (SD board; harmless if absent on a board). */
const REP_STATUS_COL = "color_mm8mbxts";
const OFF = "Off";
const ON = "On";

// ── Monday GraphQL (retrying; same policy as monday-live-dispatch) ──────────

const MONDAY_API = "https://api.monday.com/v2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = /complexity|rate.?limit|concurrency|minute limit|call limit/i;

async function monday(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= 3; attempt++) {
    let waitS = 2 ** attempt;
    try {
      const resp = await fetch(MONDAY_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: token,
          "API-Version": "2026-07",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      });
      const text = await resp.text();
      let json: {
        data?: unknown;
        errors?: Array<{ message?: string; extensions?: { retry_in_seconds?: number } }>;
      } | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* non-JSON */
      }
      if (resp.status === 429 || resp.status >= 500 || (resp.status === 409 && idempotencyKey)) {
        lastError = `HTTP ${resp.status}: ${text.slice(0, 200)}`;
        const ra = Number(resp.headers.get("retry-after") ?? NaN);
        if (Number.isFinite(ra)) waitS = ra;
      } else if (json?.errors?.length) {
        lastError = `Monday: ${JSON.stringify(json.errors).slice(0, 400)}`;
        const retryable = json.errors.some((e) => RETRYABLE.test(String(e?.message ?? "")));
        if (!retryable) throw new Error(lastError);
        const hint = Number(json.errors[0]?.extensions?.retry_in_seconds ?? NaN);
        if (Number.isFinite(hint)) waitS = hint;
      } else if (json) {
        return (json.data ?? {}) as Record<string, unknown>;
      } else {
        throw new Error(`HTTP ${resp.status} non-JSON: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Monday:")) throw e;
      if (e instanceof Error && e.message.includes("non-JSON")) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (attempt < 3) await sleep(Math.min(waitS, 30) * 1000);
  }
  throw new Error(`${lastError} (after 3 attempts)`);
}

// ── LA calendar (DST-safe) ───────────────────────────────────────────────────

const LA_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const LA_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  hour12: false,
});

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days, 12));
  return dt.toISOString().slice(0, 10);
}

/** The Monday-start attendance week the boards should show after this run:
 *  the LA week containing now — rolled to the COMING week from Sunday 12 PM PT
 *  (identical to attendanceWeekStartISO in src/lib/respawn.ts). */
function targetWeekStartISO(now = new Date()): string {
  const iso = LA_DATE.format(now); // YYYY-MM-DD in LA
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun
  const monday = addDaysISO(iso, dow === 0 ? -6 : 1 - dow);
  const rawHour = LA_HOUR.format(now);
  const hour = Number(rawHour === "24" ? "0" : rawHour);
  if (dow === 0 && hour >= 12) return addDaysISO(monday, 7);
  return monday;
}

// ── Name matching (board rows are labeled loosely) ──────────────────────────

const normName = (s: string | null | undefined) =>
  (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const firstName = (s: string | null | undefined) => normName(s).split(" ")[0] ?? "";

type BoardRow = { id: string; name: string; repStatus: string };

/** Match a rep (profiles display_name) to a board row: exact normalized full
 *  name first, else a UNIQUE first-name match (SD labels rows "Nick S",
 *  "Jaxon no day off reply" — first names are unique within an office). */
function matchRow(rows: BoardRow[], repName: string): BoardRow | null {
  const full = normName(repName);
  const exact = rows.find((r) => normName(r.name) === full);
  if (exact) return exact;
  const fn = firstName(repName);
  if (!fn) return null;
  const byFirst = rows.filter((r) => firstName(r.name) === fn);
  return byFirst.length === 1 ? byFirst[0] : null;
}

// ── HTTP entry ───────────────────────────────────────────────────────────────

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const notifySecret = Deno.env.get("NOTIFY_SECRET");
  const provided = req.headers.get("x-notify-secret") ?? url.searchParams.get("secret");
  if (notifySecret && provided !== notifySecret) {
    return new Response("unauthorized", { status: 401, headers: corsHeaders });
  }
  const force = url.searchParams.get("force") === "true";
  const dryRun = url.searchParams.get("dry_run") === "true";

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // select("*") on purpose: a narrow list naming a not-yet-migrated column
    // would fail the whole read if this deploys before the migration.
    const { data: settings } = await supabase.from("system_settings").select("*").maybeSingle();
    const token = ((settings?.monday_api_token as string | null) ?? "").trim();
    const enabled = (settings?.respawn_weekly_reset_enabled as boolean | null) ?? false;
    if (!enabled && !force) return ok({ skipped: "respawn_weekly_reset_enabled is off" });
    if (!token) return ok({ error: "no Monday API token configured" });

    const weekStart = targetWeekStartISO();

    // Approved shifts to KEEP/SET Off: recurring (standing) + the new week's
    // one-time grants. approved_shifts falls back to the full request for any
    // legacy row decided before the partial column existed.
    const [{ data: recurring }, { data: oneTime }] = await Promise.all([
      supabase
        .from("respawn_recurring")
        .select("rep_name, office, shifts, approved_shifts, status")
        .in("status", ["approved", "partial"]),
      supabase
        .from("respawn_requests")
        .select("rep_name, office, shifts, approved_shifts, status")
        .in("status", ["approved", "partial"])
        .eq("week_start", weekStart),
    ]);

    type OffRow = { repName: string; shifts: string[]; kind: "recurring" | "week" };
    const offRows: Record<RepOffice, OffRow[]> = { SD: [], OC: [] };
    const collect = (
      rows:
        | Array<{
            rep_name: string;
            office: string;
            shifts: string[] | null;
            approved_shifts: string[] | null;
          }>
        | null,
      kind: OffRow["kind"],
    ) => {
      for (const r of rows ?? []) {
        const office: RepOffice = r.office === "OC" ? "OC" : "SD";
        const granted = (r.approved_shifts ?? r.shifts ?? []).filter((s) => s in SHIFT_COL);
        if (granted.length > 0) offRows[office].push({ repName: r.rep_name, shifts: granted, kind });
      }
    };
    collect(recurring as never, "recurring");
    collect(oneTime as never, "week");

    const summary: Record<string, unknown> = { weekStart, dryRun };
    for (const office of ["SD", "OC"] as const) {
      const boardId = ATTENDANCE_BOARD[office];
      const data = await monday(
        token,
        `query ($b: ID!, $cols: [String!]) {
          boards(ids: [$b]) {
            items_page(limit: 200) {
              items { id name column_values(ids: $cols) { id text } }
            }
          }
        }`,
        { b: boardId, cols: [REP_STATUS_COL] },
      );
      const items =
        ((data.boards as Array<{
          items_page?: { items?: Array<Record<string, unknown>> };
        }> | null) ?? [])[0]?.items_page?.items ?? [];
      const rows: BoardRow[] = items.map((it) => {
        const cv = (it.column_values as Array<{ id: string; text: string | null }>) ?? [];
        return {
          id: String(it.id),
          name: String(it.name ?? ""),
          repStatus: (cv.find((c) => c.id === REP_STATUS_COL)?.text ?? "").trim(),
        };
      });

      // itemId → set of shift keys to mark Off; reps with grants but no row.
      const offByItem = new Map<string, Set<string>>();
      const unmatched: string[] = [];
      for (const r of offRows[office]) {
        const row = matchRow(rows, r.repName);
        if (!row) {
          unmatched.push(`${r.repName} (${r.kind}: ${r.shifts.join(",")})`);
          continue;
        }
        const set = offByItem.get(row.id) ?? new Set<string>();
        for (const s of r.shifts) set.add(s);
        offByItem.set(row.id, set);
      }

      let reset = 0;
      let skipped = 0;
      const plan: Array<{ item: string; name: string; off: string[] }> = [];
      for (const row of rows) {
        if (row.repStatus === "Left") {
          skipped += 1;
          continue;
        }
        const offs = offByItem.get(row.id) ?? new Set<string>();
        const colVals: Record<string, { label: string }> = {};
        for (const s of SHIFT_KEYS) colVals[SHIFT_COL[s]] = { label: offs.has(s) ? OFF : ON };
        plan.push({ item: row.id, name: row.name, off: [...offs] });
        if (!dryRun) {
          await monday(
            token,
            `mutation ($b: ID!, $i: ID!, $vals: JSON!) {
              change_multiple_column_values(board_id: $b, item_id: $i, column_values: $vals) { id }
            }`,
            { b: boardId, i: row.id, vals: JSON.stringify(colVals) },
            `respawn-reset-${office}-${row.id}-${weekStart}`,
          );
        }
        reset += 1;
      }
      summary[office] = { reset, skippedLeft: skipped, unmatched, plan: dryRun ? plan : undefined };
      console.log(
        `[respawn-reset] ${office} week ${weekStart}: ${reset} rows reset, ${skipped} Left skipped, ${unmatched.length} unmatched`,
        unmatched,
      );
    }

    return ok({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[respawn-reset] error", msg);
    return ok({ ok: false, error: msg });
  }
});
