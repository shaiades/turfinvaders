import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Historical CSV import → Paycheck Engine.
 *
 * Owner-only. Auto-creates canvasser profiles via Auth Admin when the
 * "Agent" name is unknown, then upserts daily_logs and inserts confirmed
 * SALE leads with sale_amount. Downstream the `calc_weekly_paycheck` /
 * `calc_monthly_paycheck` functions (Prompt 15) compute pay from these rows.
 */

type Outcome = "BO" | "OL" | "RS" | "PM" | "SALE";

type CsvImportRow = {
  agent: string;
  outcome: string;
  date: string;
  sale_price: string | number | null;
  lead_name: string | null;
  van: string | null;
};

type CsvImportInput = {
  rows: CsvImportRow[];
  team_id: string | null;
  refresh_existing: boolean;
  refresh_rows: CsvImportRow[] | null;
  final_import: boolean;
  final_rows: CsvImportRow[] | null;
};

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function coerceCsvImportInput(data: unknown): CsvImportInput {
  const input = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const coerceRows = (value: unknown): CsvImportRow[] => {
    const rows = Array.isArray(value) ? value : [];
    return rows.slice(0, 5000).map((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        agent: toStringValue(row.agent),
        outcome: toStringValue(row.outcome),
        date: toStringValue(row.date),
        sale_price: row.sale_price === null || row.sale_price === undefined ? null : toStringValue(row.sale_price),
        lead_name: toStringValue(row.lead_name) || null,
        van: toStringValue(row.van) || null,
      };
    });
  };
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    rows: coerceRows(input.rows),
    team_id: typeof input.team_id === "string" && uuidLike.test(input.team_id) ? input.team_id : null,
    refresh_existing: input.refresh_existing !== false,
    refresh_rows: Array.isArray(input.refresh_rows) ? coerceRows(input.refresh_rows) : null,
    final_import: input.final_import === true,
    final_rows: Array.isArray(input.final_rows) ? coerceRows(input.final_rows) : null,
  };
}

function normalizeOutcome(raw: string | null | undefined): Outcome | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  if (k === "bo" || k.includes("blowout")) return "BO";
  if (k === "ctc" || k.includes("calltocancel") || k.includes("cancel")) return "BO"; // CTC counts as no-demo
  if (k === "ol" || k.includes("oneleg") || k.includes("1leg")) return "OL";
  if (k === "rs" || k.includes("reset")) return "RS";
  if (k === "pm" || k.includes("pitchmiss") || k.includes("demo") || k.includes("sit")) return "PM";
  if (k.includes("sale") || k.includes("sold") || k.includes("close") || k === "win") return "SALE";
  return null;
}


function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const val = v ? v.toString().trim() : "";
  if (!val) return 0;
  const cleaned = val.replace(/[^0-9.-]+/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  // Try mm/dd/yyyy
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d2 = new Date(yr, Number(m[1]) - 1, Number(m[2]));
    if (!isNaN(d2.getTime())) return d2.toISOString().slice(0, 10);
  }
  return null;
}

function weekStartMonday(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "agent";
}

export const importHistoricalCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(coerceCsvImportInput)
  .handler(async ({ data, context }) => {
    // Owner gate
    const { data: isOwner, error: roleErr } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "owner",
    });
    if (roleErr) throw new Error(roleErr.message);
    if (!isOwner) throw new Error("Forbidden: Owner role required");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const errors: { row: number; reason: string }[] = [];
    const profileCache = new Map<string, { id: string; team_id: string | null }>();
    let created_profiles = 0;
    let updated_logs = 0;
    let inserted_sales = 0;

    // Aggregate per (canvasser, date) to minimize round-trips.
    type Bucket = {
      profileKey: string;
      log_date: string;
      no_demo: number;
      one_legs: number;
      future_leads: number;
      demos_sits: number;
      sales: number;
      sale_rows: { amount: number | null; lead_name: string | null }[];
    };
    const buckets = new Map<string, Bucket>();

    // Capture the most recent non-empty Van label per agent so we can
    // permanently assign them to that team in profiles.team_id.
    const vanByAgent = new Map<string, string>();

    const rowsForRefresh = data.refresh_rows ?? data.rows;
    const rowsForFinalCalculations = data.final_rows ?? data.rows;

    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      const name = r.agent.trim();
      // Silently skip blank-agent rows (Monday exports often have spacer rows).
      if (!name) continue;
      const vanRaw = (r.van ?? "").trim();
      if (vanRaw) vanByAgent.set(name.toLowerCase(), vanRaw);
      const outcome = normalizeOutcome(r.outcome);
      // Silently skip rows with no recognizable outcome — do not surface as error.
      if (!outcome) continue;
      const logDate = parseDate(r.date);
      if (!logDate) { errors.push({ row: i + 1, reason: `Unparseable date for ${name}: ${r.date}` }); continue; }


      const key = `${name.toLowerCase()}|${logDate}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          profileKey: name,
          log_date: logDate,
          no_demo: 0, one_legs: 0, future_leads: 0, demos_sits: 0, sales: 0, sale_rows: [],
        };
        buckets.set(key, b);
      }
      switch (outcome) {
        case "BO": b.no_demo += 1; break;
        case "OL": b.one_legs += 1; break;
        case "RS": b.future_leads += 1; break;
        case "PM": b.demos_sits += 1; break;
        case "SALE":
          b.demos_sits += 1;
          b.sales += 1;
          b.sale_rows.push({
            amount: parseMoney(r.sale_price ?? null),
            lead_name: r.lead_name ?? null,
          });
          break;
      }
    }

    // Resolve / create profiles.
    async function resolveProfile(name: string): Promise<{ id: string; team_id: string | null } | null> {
      const k = name.toLowerCase();
      const cached = profileCache.get(k);
      if (cached) return cached;
      const { data: existing } = await supabaseAdmin
        .from("profiles")
        .select("id, team_id, display_name")
        .ilike("display_name", name)
        .maybeSingle();
      if (existing) {
        const v = { id: existing.id, team_id: existing.team_id };
        profileCache.set(k, v);
        return v;
      }
      // Create auth user → handle_new_user trigger creates the profile + canvasser role.
      const email = `csv-import+${slugify(name)}-${Date.now().toString(36)}@knockout.local`;
      const { data: created, error: cErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        email_confirm: true,
        password: crypto.randomUUID(),
        user_metadata: { display_name: name, source: "csv_import" },
      });
      if (cErr || !created.user) {
        errors.push({ row: 0, reason: `Could not auto-create canvasser ${name}: ${cErr?.message ?? "unknown"}` });
        return null;
      }
      // Assign default team_id if requested.
      if (data.team_id) {
        await supabaseAdmin.from("profiles").update({ team_id: data.team_id }).eq("id", created.user.id);
      }
      created_profiles += 1;
      const v = { id: created.user.id, team_id: data.team_id ?? null };
      profileCache.set(k, v);
      return v;
    }

    // Resolve / create a Van (team) by name, case-insensitive.
    const teamCache = new Map<string, string>();
    async function resolveTeamId(vanName: string): Promise<string | null> {
      const key = vanName.toLowerCase();
      const hit = teamCache.get(key);
      if (hit) return hit;
      const { data: existing } = await supabaseAdmin
        .from("teams").select("id, name").ilike("name", vanName).maybeSingle();
      if (existing) { teamCache.set(key, existing.id); return existing.id; }
      const { data: created, error: cErr } = await supabaseAdmin
        .from("teams").insert({ name: vanName, color: "#10b981" }).select("id").single();
      if (cErr || !created) {
        errors.push({ row: 0, reason: `Could not create Van "${vanName}": ${cErr?.message ?? "unknown"}` });
        return null;
      }
      teamCache.set(key, created.id);
      return created.id;
    }

    // Apply Van assignments captured during row scan → permanently
    // overwrites profiles.team_id so the Payroll Ledger shows the Van label
    // even when later CSVs leave the Van column blank.
    for (const r of rowsForRefresh) {
      const name = r.agent.trim();
      const vanRaw = (r.van ?? "").trim();
      if (name && vanRaw) vanByAgent.set(name.toLowerCase(), vanRaw);
    }

    for (const [agentKey, vanName] of vanByAgent.entries()) {
      const profile = await resolveProfile(agentKey);
      if (!profile) continue;
      const teamId = await resolveTeamId(vanName);
      if (!teamId) continue;
      if (profile.team_id !== teamId) {
        await supabaseAdmin.from("profiles").update({ team_id: teamId }).eq("id", profile.id);
        profileCache.set(agentKey, { id: profile.id, team_id: teamId });
      }
    }


    // === REFRESH MODE ===
    // Wipe existing daily_logs + confirmed sale leads for each affected
    // (canvasser, date) so re-uploading a CSV for the same week never
    // double-counts. Re-uploading is the canonical "fix" workflow.
    if (data.refresh_existing) {
      const datesByProfile = new Map<string, Set<string>>();
      for (const r of rowsForRefresh) {
        const name = r.agent.trim();
        if (!name) continue;
        const logDate = parseDate(r.date);
        if (!logDate) continue;
        const profile = await resolveProfile(name);
        if (!profile) continue;
        const set = datesByProfile.get(profile.id) ?? new Set<string>();
        set.add(logDate);
        datesByProfile.set(profile.id, set);
      }
      for (const [pid, dates] of datesByProfile.entries()) {
        const dateArr = Array.from(dates);
        await supabaseAdmin.from("daily_logs").delete().eq("canvasser_id", pid).in("log_date", dateArr);
        // Confirmed sale leads keyed by reviewed_at::date — strip the day window.
        for (const d of dateArr) {
          await supabaseAdmin
            .from("leads")
            .delete()
            .eq("canvasser_id", pid)
            .eq("status", "confirmed")
            .eq("is_sale", true)
            .gte("reviewed_at", `${d}T00:00:00Z`)
            .lte("reviewed_at", `${d}T23:59:59Z`);
        }
      }
    }


    type DailyLogUpsert = {
      canvasser_id: string;
      team_id: string | null;
      log_date: string;
      no_demo: number;
      one_legs: number;
      future_leads: number;
      demos_sits: number;
      sales: number;
    };
    const dailyLogRows: DailyLogUpsert[] = [];
    const saleLeadRows: {
      canvasser_id: string;
      team_id: string | null;
      status: "confirmed";
      customer_name: string | null;
      sale_amount: number | null;
      is_sale: true;
      reviewed_at: string;
    }[] = [];

    for (const b of buckets.values()) {
      const profile = await resolveProfile(b.profileKey);
      if (!profile) continue;

      dailyLogRows.push({
        canvasser_id: profile.id,
        team_id: profile.team_id,
        log_date: b.log_date,
        no_demo: b.no_demo,
        one_legs: b.one_legs,
        future_leads: b.future_leads,
        demos_sits: b.demos_sits,
        sales: b.sales,
      });

      // Insert confirmed leads for each SALE → feeds Paycheck Engine commission.
      for (const sale of b.sale_rows) {
        saleLeadRows.push({
          canvasser_id: profile.id,
          team_id: profile.team_id,
          status: "confirmed",
          customer_name: sale.lead_name,
          sale_amount: sale.amount,
          is_sale: true,
          reviewed_at: new Date(`${b.log_date}T12:00:00Z`).toISOString(),
        });
      }
    }

    if (dailyLogRows.length > 0) {
      const { error: upsertErr } = await supabaseAdmin
        .from("daily_logs")
        .upsert(dailyLogRows, { onConflict: "canvasser_id,log_date" });
      if (upsertErr) {
        throw new Error(`daily_logs batch upsert failed: ${upsertErr.message} (code=${upsertErr.code ?? "?"}, details=${upsertErr.details ?? ""}, hint=${upsertErr.hint ?? ""})`);
      }
      updated_logs = dailyLogRows.length;
    }

    if (saleLeadRows.length > 0) {
      const { error: leadErr } = await supabaseAdmin.from("leads").insert(saleLeadRows);
      if (leadErr) {
        errors.push({ row: 0, reason: `Lead batch insert failed: ${leadErr.message} (code=${leadErr.code ?? "?"}, hint=${leadErr.hint ?? ""})` });
      } else {
        inserted_sales = saleLeadRows.length;
      }
    }

    if (buckets.size > 0 && updated_logs === 0) {
      throw new Error(`Parsed ${buckets.size} bucket(s) but wrote 0 daily_logs rows. First error: ${errors[0]?.reason ?? "unknown"}`);
    }

    if (data.final_import) {
      const refreshedProfiles = new Set<string>();
      const paycheckWeeksByProfile = new Map<string, Set<string>>();
      for (const r of rowsForFinalCalculations) {
        const name = r.agent.trim();
        if (!name) continue;
        const logDate = parseDate(r.date);
        const profile = await resolveProfile(name);
        if (!profile) continue;
        if (!refreshedProfiles.has(profile.id)) {
          const { error: rankErr } = await supabaseAdmin.rpc("refresh_canvasser_rank", {
            _canvasser_id: profile.id,
          });
          if (rankErr) {
            errors.push({
              row: 0,
              reason: `Final rank refresh failed for ${name}: ${rankErr.message}`,
            });
          }
          refreshedProfiles.add(profile.id);
        }
        if (logDate) {
          const weeks = paycheckWeeksByProfile.get(profile.id) ?? new Set<string>();
          weeks.add(weekStartMonday(logDate));
          paycheckWeeksByProfile.set(profile.id, weeks);
        }
      }

      for (const [profileId, weeks] of paycheckWeeksByProfile.entries()) {
        for (const weekStart of weeks) {
          const { error: payErr } = await supabaseAdmin.rpc("calc_weekly_paycheck", {
            _canvasser_id: profileId,
            _week_start: weekStart,
          });
          if (payErr) {
            errors.push({
              row: 0,
              reason: `Final paycheck calculation failed for week ${weekStart}: ${payErr.message}`,
            });
          }
        }
      }
    }

    return {
      ok: true,
      created_profiles,
      updated_logs,
      inserted_sales,
      bucket_count: buckets.size,
      parsed_rows: data.rows.length,
      errors: errors.slice(0, 50),
    };
  });

