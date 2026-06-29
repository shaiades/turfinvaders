import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * Historical CSV import → Paycheck Engine.
 *
 * Owner-only. Auto-creates canvasser profiles via Auth Admin when the
 * "Agent" name is unknown, then upserts daily_logs and inserts confirmed
 * SALE leads with sale_amount. Downstream the `calc_weekly_paycheck` /
 * `calc_monthly_paycheck` functions (Prompt 15) compute pay from these rows.
 */

type Outcome = "BO" | "OL" | "RS" | "PM" | "SALE";

function normalizeOutcome(raw: string | null | undefined): Outcome | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!k) return null;
  if (k === "bo" || k.includes("blowout")) return "BO";
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

const rowSchema = z.object({
  agent: z.string().min(1),
  outcome: z.string().min(1),
  date: z.string().min(1),
  sale_price: z.union([z.string(), z.number()]).nullable().optional(),
  lead_name: z.string().nullable().optional(),
});

const inputSchema = z.object({
  rows: z.array(rowSchema).min(1).max(5000),
  team_id: z.string().uuid().nullable().optional(),
});

export const importHistoricalCsv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => inputSchema.parse(data))
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

    for (let i = 0; i < data.rows.length; i++) {
      const r = data.rows[i];
      const outcome = normalizeOutcome(r.outcome);
      const logDate = parseDate(r.date);
      if (!outcome) { errors.push({ row: i + 1, reason: `Unrecognized outcome: ${r.outcome}` }); continue; }
      if (!logDate) { errors.push({ row: i + 1, reason: `Unparseable date: ${r.date}` }); continue; }
      const name = r.agent.trim();
      if (!name) { errors.push({ row: i + 1, reason: "Missing agent name" }); continue; }

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

    // Apply buckets.
    for (const b of buckets.values()) {
      const profile = await resolveProfile(b.profileKey);
      if (!profile) continue;

      // Ensure row exists.
      await supabaseAdmin
        .from("daily_logs")
        .upsert(
          { canvasser_id: profile.id, team_id: profile.team_id, log_date: b.log_date },
          { onConflict: "canvasser_id,log_date", ignoreDuplicates: true },
        );

      const { data: row } = await supabaseAdmin
        .from("daily_logs")
        .select("id, no_demo, one_legs, future_leads, demos_sits, sales")
        .eq("canvasser_id", profile.id)
        .eq("log_date", b.log_date)
        .maybeSingle();
      if (!row) continue;

      const update = {
        no_demo: (row.no_demo ?? 0) + b.no_demo,
        one_legs: (row.one_legs ?? 0) + b.one_legs,
        future_leads: (row.future_leads ?? 0) + b.future_leads,
        demos_sits: (row.demos_sits ?? 0) + b.demos_sits,
        sales: (row.sales ?? 0) + b.sales,
      };
      await supabaseAdmin.from("daily_logs").update(update).eq("id", row.id);
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
        if (lErr) errors.push({ row: 0, reason: `Lead insert failed for ${b.profileKey}: ${lErr.message}` });
        else inserted_sales += 1;
      }
    }

    return {
      ok: true,
      created_profiles,
      updated_logs,
      inserted_sales,
      bucket_count: buckets.size,
      errors: errors.slice(0, 50),
    };
  });
