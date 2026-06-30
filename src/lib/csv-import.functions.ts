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
};

function toStringValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function coerceCsvImportInput(data: unknown): CsvImportInput {
  const input = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    rows: rows.slice(0, 5000).map((raw) => {
      const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      return {
        agent: toStringValue(row.agent),
        outcome: toStringValue(row.outcome),
        date: toStringValue(row.date),
        sale_price: row.sale_price === null || row.sale_price === undefined ? null : toStringValue(row.sale_price),
        lead_name: toStringValue(row.lead_name) || null,
        van: toStringValue(row.van) || null,
      };
    }),
    team_id: typeof input.team_id === "string" && uuidLike.test(input.team_id) ? input.team_id : null,
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
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
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
    const datesByProfile = new Map<string, Set<string>>();
    for (const b of buckets.values()) {
      const profile = await resolveProfile(b.profileKey);
      if (!profile) continue;
      const set = datesByProfile.get(profile.id) ?? new Set<string>();
      set.add(b.log_date);
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


    for (const b of buckets.values()) {
      const profile = await resolveProfile(b.profileKey);
      if (!profile) continue;

      // Upsert row — return existing values so we can accumulate.
      const { error: insErr } = await supabaseAdmin
        .from("daily_logs")
        .upsert(
          { canvasser_id: profile.id, team_id: profile.team_id, log_date: b.log_date },
          { onConflict: "canvasser_id,log_date", ignoreDuplicates: true },
        );
      if (insErr) {
        throw new Error(`daily_logs upsert failed for ${b.profileKey} on ${b.log_date}: ${insErr.message} (code=${insErr.code ?? "?"}, details=${insErr.details ?? ""}, hint=${insErr.hint ?? ""})`);
      }

      const { data: row, error: selErr } = await supabaseAdmin
        .from("daily_logs")
        .select("id, no_demo, one_legs, future_leads, demos_sits, sales")
        .eq("canvasser_id", profile.id)
        .eq("log_date", b.log_date)
        .maybeSingle();
      if (selErr) throw new Error(`daily_logs select failed for ${b.profileKey}: ${selErr.message}`);
      if (!row) throw new Error(`daily_logs row missing after upsert for ${b.profileKey} on ${b.log_date}`);

      const update = {
        no_demo: (row.no_demo ?? 0) + b.no_demo,
        one_legs: (row.one_legs ?? 0) + b.one_legs,
        future_leads: (row.future_leads ?? 0) + b.future_leads,
        demos_sits: (row.demos_sits ?? 0) + b.demos_sits,
        sales: (row.sales ?? 0) + b.sales,
      };
      const { error: updErr } = await supabaseAdmin.from("daily_logs").update(update).eq("id", row.id);
      if (updErr) {
        throw new Error(`daily_logs update failed for ${b.profileKey} on ${b.log_date}: ${updErr.message} (code=${updErr.code ?? "?"}, details=${updErr.details ?? ""}, hint=${updErr.hint ?? ""})`);
      }
      updated_logs += 1;

      // Insert confirmed leads for each SALE → feeds Paycheck Engine commission.
      for (const sale of b.sale_rows) {
        const { error: lErr } = await supabaseAdmin.from("leads").insert({
          canvasser_id: profile.id,
          team_id: profile.team_id,
          status: "confirmed",
          customer_name: sale.lead_name,
          sale_amount: sale.amount,
          is_sale: true,
          reviewed_at: new Date(`${b.log_date}T12:00:00Z`).toISOString(),
        });
        if (lErr) {
          errors.push({ row: 0, reason: `Lead insert failed for ${b.profileKey}: ${lErr.message} (code=${lErr.code ?? "?"}, hint=${lErr.hint ?? ""})` });
        } else {
          inserted_sales += 1;
        }
      }
    }

    if (buckets.size > 0 && updated_logs === 0) {
      throw new Error(`Parsed ${buckets.size} bucket(s) but wrote 0 daily_logs rows. First error: ${errors[0]?.reason ?? "unknown"}`);
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

