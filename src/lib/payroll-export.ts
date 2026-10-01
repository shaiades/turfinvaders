import { supabase } from "@/integrations/supabase/client";
import { fetchWeeklyPaychecksChunked } from "@/lib/paychecks";
import { csvCell } from "@/lib/csv";
import { addDaysISO, laDateTimeLabel, laMidnightUtcISO } from "@/lib/dates";

/**
 * The accountant's export builders (Reports console). Every builder returns
 * CSV lines (header first), all cells injection-guarded, all timestamps
 * Pacific. Doctrine:
 *   · APPROVED weeks export the FROZEN payroll_run_lines (what was actually
 *     paid, clawbacks included); unapproved weeks export the live engine.
 *   · The punch-detail export is the CA-required time record (LC 1174):
 *     per person per day, exact in/out and meal times, voids included and
 *     marked — never silently dropped.
 */

const num = (v: unknown) => Number(v ?? 0);

export const PAYROLL_RANGE_HEADERS = [
  "Week Start",
  "Employee ID",
  "Agent Name",
  "Van (current)",
  "Rank",
  "Reg Hours",
  "OT Hours (1.5x)",
  "DT Hours (2x)",
  "Total Hours",
  "Hourly Rate",
  "Regular Rate",
  "Base Pay (straight time)",
  "OT Premium Pay",
  "Meal Premium Days",
  "Meal Premium Pay",
  "Total Sales Volume ($)",
  "Commission Rate",
  "Commission Earned ($)",
  "Commission Adjustment ($)",
  "Sit Bonus",
  "Monster Bonus",
  "Total Pay ($)",
  "Source",
  "Attested",
  "Exceptions",
];

const exceptionsSummary = (ex: Record<string, unknown> | null | undefined) =>
  Object.keys(ex ?? {})
    .filter((k) => k !== "attestation" && (Number((ex as Record<string, unknown>)[k]) > 0 || (ex as Record<string, unknown>)[k] === true))
    .join("; ");

/** Monday-anchored list of week starts, inclusive. */
export function weekStartsInRange(fromWeekISO: string, toWeekISO: string): string[] {
  const out: string[] = [];
  for (let w = fromWeekISO; w <= toWeekISO && out.length < 60; w = addDaysISO(w, 7)) out.push(w);
  return out;
}

export async function buildPayrollRangeCsvLines(weekStarts: string[]): Promise<string[]> {
  const lines = [PAYROLL_RANGE_HEADERS.join(",")];

  const [profilesRes, teamsRes] = await Promise.all([
    supabase.from("profiles").select("id, display_name, team_id"),
    supabase.from("teams").select("id, name"),
  ]);
  if (profilesRes.error) throw profilesRes.error;
  if (teamsRes.error) throw teamsRes.error;
  const profiles = profilesRes.data ?? [];
  const teamName = new Map((teamsRes.data ?? []).map((t) => [t.id, t.name]));
  const profById = new Map(profiles.map((p) => [p.id, p]));
  const vanOf = (id: string) => {
    const p = profById.get(id);
    return (p?.team_id && teamName.get(p.team_id)) || "";
  };

  for (const weekStart of weekStarts) {
    // Worker sign-off state (empty map when the table hasn't shipped).
    const attest = new Map<string, string>();
    {
      const { data } = await supabase
        .from("time_week_attestations")
        .select("user_id, status")
        .eq("week_start", weekStart)
        .is("superseded_at", null);
      for (const a of data ?? []) attest.set(a.user_id, a.status);
    }

    const { data: run } = await supabase
      .from("payroll_runs")
      .select("id, status")
      .eq("week_start", weekStart)
      .neq("status", "reopened")
      .maybeSingle();

    if (run?.status === "approved") {
      const { data: rows, error } = await supabase
        .from("payroll_run_lines")
        .select("*")
        .eq("run_id", run.id)
        .order("display_name");
      if (error) throw error;
      for (const l of rows ?? []) {
        const ex = (l.exceptions ?? {}) as Record<string, unknown>;
        const snap = (l.snapshot ?? {}) as Record<string, unknown>;
        lines.push(
          [
            weekStart,
            l.canvasser_id,
            l.display_name,
            vanOf(l.canvasser_id),
            l.rank ?? "",
            num(l.reg_hours).toFixed(2),
            num(l.ot_hours).toFixed(2),
            num(l.dt_hours).toFixed(2),
            num(l.hours).toFixed(2),
            num(l.hourly_rate).toFixed(2),
            num(l.regular_rate).toFixed(4),
            num(l.base_pay).toFixed(2),
            num(l.ot_premium_pay).toFixed(2),
            l.meal_premium_count,
            num(l.meal_premium_pay).toFixed(2),
            num(snap.sale_price_total).toFixed(2),
            snap.commission_rate != null ? `${(num(snap.commission_rate) * 100).toFixed(0)}%` : "",
            num(l.commission).toFixed(2),
            num((l as Record<string, unknown>).commission_adjustment).toFixed(2),
            num(l.sit_bonus).toFixed(2),
            num(l.monster_bonus).toFixed(2),
            num(l.total_pay).toFixed(2),
            "approved run (frozen)",
            String(ex.attestation ?? attest.get(l.canvasser_id) ?? ""),
            exceptionsSummary(ex),
          ]
            .map(csvCell)
            .join(","),
        );
      }
      continue;
    }

    const results = await fetchWeeklyPaychecksChunked(
      weekStart,
      profiles.map((p) => p.id),
    );
    const paid = results
      .filter((r) => r.paycheck && (num(r.paycheck.hours) > 0 || num(r.paycheck.total_pay) > 0))
      .sort((a, b) =>
        (profById.get(a.canvasser_id)?.display_name ?? "").localeCompare(
          profById.get(b.canvasser_id)?.display_name ?? "",
        ),
      );
    for (const r of paid) {
      const pc = r.paycheck!;
      lines.push(
        [
          weekStart,
          r.canvasser_id,
          profById.get(r.canvasser_id)?.display_name ?? r.canvasser_id,
          vanOf(r.canvasser_id),
          pc.rank ?? "",
          num(pc.reg_hours).toFixed(2),
          num(pc.ot_hours).toFixed(2),
          num(pc.dt_hours).toFixed(2),
          num(pc.hours).toFixed(2),
          num(pc.hourly_rate).toFixed(2),
          num(pc.regular_rate).toFixed(4),
          num(pc.base_pay).toFixed(2),
          num(pc.ot_premium_pay).toFixed(2),
          pc.meal_premium_count ?? 0,
          num(pc.meal_premium_pay).toFixed(2),
          num(pc.sale_price_total).toFixed(2),
          `${(num(pc.commission_rate) * 100).toFixed(0)}%`,
          num(pc.commission).toFixed(2),
          "", // cross-week adjustments exist only on runs
          num(pc.sit_bonus).toFixed(2),
          num(pc.monster_bonus).toFixed(2),
          num(pc.total_pay).toFixed(2),
          "live engine (no approved run)",
          attest.get(r.canvasser_id) ?? "",
          exceptionsSummary(pc.exceptions as Record<string, unknown> | null),
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return lines;
}

export const PUNCH_DETAIL_HEADERS = [
  "Date",
  "Employee ID",
  "Name",
  "Van (current)",
  "Clock In (PT)",
  "Clock Out (PT)",
  "First Meal Out (PT)",
  "Last Meal In (PT)",
  "Meals Recorded",
  "Meal Minutes",
  "Billable Hours",
  "Meal Status",
  "2nd Meal Status",
  "Entry Source",
  "Flags",
  "Needs Review",
  "Voided",
  "Void Reason",
];

export async function buildPunchDetailCsvLines(
  startISO: string,
  endISO: string,
): Promise<string[]> {
  const lines = [PUNCH_DETAIL_HEADERS.join(",")];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("timesheet_day_detail")
      .select("*")
      .gte("log_date", startISO)
      .lte("log_date", endISO)
      .order("log_date", { ascending: true })
      .order("display_name", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      throw new Error(
        /timesheet_day_detail/.test(error.message)
          ? "The punch-detail view isn't deployed yet — apply migration 20261002170000 first."
          : error.message,
      );
    }
    for (const r of data ?? []) {
      lines.push(
        [
          r.log_date ?? "",
          r.user_id ?? "",
          r.display_name ?? "",
          r.team_name ?? "",
          r.clock_in ? laDateTimeLabel(r.clock_in) : "",
          r.clock_out ? laDateTimeLabel(r.clock_out) : "",
          r.first_meal_start ? laDateTimeLabel(r.first_meal_start) : "",
          r.last_meal_end ? laDateTimeLabel(r.last_meal_end) : "",
          r.meal_count ?? 0,
          r.meal_minutes ?? 0,
          num(r.billable_hours).toFixed(2),
          r.meal_status ?? "",
          r.second_meal_status ?? "",
          r.entry_source ?? "",
          (r.flag_reasons ?? []).join("; "),
          r.needs_correction ? "yes" : "",
          r.voided_at ? "VOIDED" : "",
          r.void_reason ?? "",
        ]
          .map(csvCell)
          .join(","),
      );
    }
    if ((data ?? []).length < PAGE) break;
  }
  return lines;
}

export const AUDIT_LOG_HEADERS = [
  "Timestamp (PT)",
  "Action",
  "Actor",
  "Entry Owner",
  "Entry Date",
  "Reason",
  "Old Clock In (PT)",
  "Old Clock Out (PT)",
  "New Clock In (PT)",
  "New Clock Out (PT)",
  "Old Meal Status",
  "New Meal Status",
];

export async function buildAuditCsvLines(startISO: string, endISO: string): Promise<string[]> {
  const lines = [AUDIT_LOG_HEADERS.join(",")];
  const names = new Map<string, string>();
  {
    const { data } = await supabase.from("profiles").select("id, display_name");
    for (const p of data ?? []) names.set(p.id, p.display_name ?? p.id);
  }
  const nameOf = (id: unknown) =>
    typeof id === "string" && id ? (names.get(id) ?? id) : "";
  const t = (v: unknown) => (typeof v === "string" && v ? laDateTimeLabel(v) : "");

  const PAGE = 1000;
  // happened_at is a timestamptz; bound by LA calendar days (DST-safe).
  const startTs = laMidnightUtcISO(startISO);
  const endTs = laMidnightUtcISO(addDaysISO(endISO, 1));
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("time_entry_audit")
      .select("happened_at, actor, action, reason, old_row, new_row")
      .gte("happened_at", startTs)
      .lt("happened_at", endTs)
      .order("happened_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) {
      const oldRow = (r.old_row ?? {}) as Record<string, unknown>;
      const newRow = (r.new_row ?? {}) as Record<string, unknown>;
      lines.push(
        [
          laDateTimeLabel(r.happened_at),
          r.action,
          r.actor ? nameOf(r.actor) : "System (auto)",
          nameOf(newRow.user_id ?? oldRow.user_id),
          String(newRow.log_date ?? oldRow.log_date ?? ""),
          r.reason ?? "",
          t(oldRow.clock_in),
          t(oldRow.clock_out),
          t(newRow.clock_in),
          t(newRow.clock_out),
          String(oldRow.meal_status ?? ""),
          String(newRow.meal_status ?? ""),
        ]
          .map(csvCell)
          .join(","),
      );
    }
    if ((data ?? []).length < PAGE) break;
  }
  return lines;
}
