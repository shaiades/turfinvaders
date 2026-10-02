// Kombat Month server functions (owner directive 2026-10-02).
//  • recomputeKombat — admin button + post-sync hook: rebuild the ledger.
//  • reviewContestProof — the ONLY write path for proof review: computes
//    capped points server-side and writes the proof row + its locked
//    ledger row together. Clients can only INSERT pending proofs (RLS).
//  • getKombatAdminBoard — eligibility inputs across every sales rep for
//    the owner projection (purpose_profiles and activity_tests are not
//    cross-readable by design; this fn is the admin-gated bridge).

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import type { KombatRecomputeSummary } from "@/lib/kombat-month.server";
import { PROOF_LABELS, type ProofCategory } from "@/lib/kombat-month";

type AuthCtx = {
  supabase: {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (
          col: string,
          v: unknown,
        ) => PromiseLike<{
          data: Array<{ role: string }> | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  userId: string;
};

/** ADMIN only (owner/office_staff — "Manager"): same gate as syncBlockCards.
 *  Captains and reps read the contest but never approve, recompute or tune.
 *  Checks the REAL user_roles rows, so View-As can't reach it. */
async function requireAdmin(context: AuthCtx): Promise<void> {
  const { data: roleRows, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  const roles = (roleRows ?? []).map((r) => r.role);
  if (!roles.includes("owner") && !roles.includes("office_staff")) {
    throw new Error("Only Owners or Managers can do that.");
  }
}

export const recomputeKombat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<KombatRecomputeSummary> => {
    await requireAdmin(context as unknown as AuthCtx);
    const { runKombatRecompute } = await import("@/lib/kombat-month.server");
    return runKombatRecompute();
  });

const reviewInput = z.object({
  id: z.string().uuid(),
  approve: z.boolean(),
  deny_reason: z.string().trim().max(500).optional(),
});

export type ReviewProofResult = {
  status: "approved" | "denied";
  points_awarded: number | null;
  cap_note: string | null;
};

export const reviewContestProof = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => reviewInput.parse(data))
  .handler(async ({ data, context }): Promise<ReviewProofResult> => {
    await requireAdmin(context as unknown as AuthCtx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { laDateISO } = await import("@/lib/dates");
    const { computeProofAward } = await import("@/lib/kombat-month");
    const { loadKombatBounties, loadKombatRules } = await import("@/lib/kombat-month.server");
    const ctx = context as unknown as AuthCtx;

    const { data: proof, error } = await supabaseAdmin
      .from("contest_proofs")
      .select(
        "id, rep_id, category, note, link_url, customer_name, sat_on, storage_path, status, created_at",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!proof) throw new Error("Proof not found.");
    if (proof.status !== "pending") throw new Error("Only pending proofs can be reviewed.");

    const nowISO = new Date().toISOString();
    if (!data.approve) {
      const reason = (data.deny_reason ?? "").trim();
      if (reason === "") throw new Error("A reason is required to deny — the rep reads it.");
      // .select() turns the guarded UPDATE into a compare-and-swap: a 0-row
      // match (another admin already reviewed it) must surface, not silently
      // succeed (review 2026-10-02 — the deny/approve race minted points for
      // denied proofs).
      const { data: denied, error: upErr } = await supabaseAdmin
        .from("contest_proofs")
        .update({
          status: "denied",
          deny_reason: reason,
          reviewed_by: ctx.userId,
          reviewed_at: nowISO,
        })
        .eq("id", proof.id)
        .eq("status", "pending")
        .select("id");
      if (upErr) throw new Error(upErr.message);
      if ((denied ?? []).length === 0) {
        throw new Error("Someone already reviewed this proof — refresh the queue.");
      }
      return { status: "denied", points_awarded: null, cap_note: null };
    }

    const rules = await loadKombatRules();
    const bounties = await loadKombatBounties();
    const category = proof.category as ProofCategory;
    const onISO = laDateISO(new Date(proof.created_at));

    // Prior approved proofs this contest month (LA submission days) — the
    // cap inputs. points_awarded is the authoritative spent figure.
    const { data: priorRows, error: priorErr } = await supabaseAdmin
      .from("contest_proofs")
      .select("category, points_awarded, created_at")
      .eq("rep_id", proof.rep_id)
      .eq("status", "approved");
    if (priorErr) throw new Error(priorErr.message);
    const monthPrefix = rules.contest.month.slice(0, 7);
    const prior = (priorRows ?? [])
      .map((p) => ({
        category: p.category as ProofCategory,
        points: p.points_awarded ?? 0,
        on: laDateISO(new Date(p.created_at)),
      }))
      .filter((p) => p.on.startsWith(monthPrefix));

    const award = computeProofAward(category, onISO, prior, rules, bounties);

    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("id", proof.rep_id)
      .maybeSingle();
    const repName = (profile?.display_name ?? "").trim();
    if (repName === "") throw new Error("The rep has no profile display name — fix that first.");

    // Compare-and-swap, same as the deny path: 0 rows = someone beat us.
    const { data: approved, error: apErr } = await supabaseAdmin
      .from("contest_proofs")
      .update({
        status: "approved",
        points_awarded: award.points,
        reviewed_by: ctx.userId,
        reviewed_at: nowISO,
      })
      .eq("id", proof.id)
      .eq("status", "pending")
      .select("id");
    if (apErr) throw new Error(apErr.message);
    if ((approved ?? []).length === 0) {
      throw new Error("Someone already reviewed this proof — refresh the queue.");
    }

    // Proof points lock at approval — the approval IS the verification.
    // The proof's own row keeps the rep's note; the ledger meta stays with
    // what every contest role may read (label/link/customer/cap).
    const { data: ledRow, error: ledErr } = await supabaseAdmin
      .from("contest_ledger")
      .insert({
        month: rules.contest.month,
        rep_name: repName,
        category: `proof.${category}`,
        points: award.points,
        status: "locked",
        source_kind: "proof",
        source_id: proof.id,
        occurred_on: onISO,
        locked_at: nowISO,
        meta: {
          label: PROOF_LABELS[category],
          ...(proof.link_url ? { link_url: proof.link_url } : {}),
          ...(proof.customer_name ? { customer: proof.customer_name } : {}),
          ...(proof.sat_on ? { sat_on: proof.sat_on } : {}),
          ...(award.cap_note ? { cap_note: award.cap_note } : {}),
        } as never,
      })
      .select("id")
      .single();
    if (ledErr) throw new Error(ledErr.message);

    // Concurrent-approval cap sweep (review 2026-10-02): two different
    // proofs for the same rep approved in the same instant each read a
    // prior set that excludes the other, so both can clear a cap that only
    // fits one. Re-read AFTER our writes landed and, if the cap is now
    // blown, clamp THIS award (our own just-minted row — microseconds old,
    // still ours to correct) down to what actually fits.
    const { data: afterRows } = await supabaseAdmin
      .from("contest_proofs")
      .select("id, category, points_awarded, created_at")
      .eq("rep_id", proof.rep_id)
      .eq("status", "approved");
    const priorAfter = (afterRows ?? [])
      .filter((p) => p.id !== proof.id)
      .map((p) => ({
        category: p.category as ProofCategory,
        points: p.points_awarded ?? 0,
        on: laDateISO(new Date(p.created_at)),
      }))
      .filter((p) => p.on.startsWith(monthPrefix));
    let finalAward = award;
    if (priorAfter.length !== prior.length) {
      const recheck = computeProofAward(category, onISO, priorAfter, rules, bounties);
      if (recheck.points < award.points) {
        finalAward = recheck;
        await supabaseAdmin
          .from("contest_proofs")
          .update({ points_awarded: recheck.points })
          .eq("id", proof.id);
        await supabaseAdmin
          .from("contest_ledger")
          .update({
            points: recheck.points,
            meta: {
              label: PROOF_LABELS[category],
              ...(proof.link_url ? { link_url: proof.link_url } : {}),
              ...(proof.customer_name ? { customer: proof.customer_name } : {}),
              ...(proof.sat_on ? { sat_on: proof.sat_on } : {}),
              ...(recheck.cap_note ? { cap_note: recheck.cap_note } : {}),
            } as never,
          })
          .eq("id", ledRow.id);
      }
    }

    return { status: "approved", points_awarded: finalAward.points, cap_note: finalAward.cap_note };
  });

export type KombatAdminRep = {
  user_id: string;
  display_name: string;
  purpose_submitted: boolean;
  test_days: string[];
};

export type KombatAdminBoard = {
  month: string;
  reps: KombatAdminRep[];
  /** Ledger rep_names holding ≥1 non-cancelled Sale row (the eligibility
   *  gate — points count right away; the month-end window finalizes). */
  counted_sale_reps: string[];
};

export const getKombatAdminBoard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<KombatAdminBoard> => {
    await requireAdmin(context as unknown as AuthCtx);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { weekStartOfISO, nextMonthStartISO } = await import("@/lib/dates");
    const { loadKombatRules } = await import("@/lib/kombat-month.server");
    const rules = await loadKombatRules();
    const month = rules.contest.month;

    const { data: roleRows, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("user_id")
      .eq("role", "sales_rep");
    if (roleErr) throw new Error(roleErr.message);
    const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
    if (ids.length === 0) return { month, reps: [], counted_sale_reps: [] };

    const { data: profiles, error: profErr } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name, is_active")
      .in("id", ids);
    if (profErr) throw new Error(profErr.message);

    // purpose_profiles / activity_tests are not in the generated Database
    // types (same situation as objection_attempts — see dojoTable); a loose
    // accessor keeps the reads honest without a types regen.
    const raw = supabaseAdmin as unknown as {
      from: (table: string) => {
        select: (cols: string) => {
          in: (
            col: string,
            vals: string[],
          ) => PromiseLike<{ data: Record<string, string>[] | null }> & {
            gte: (
              col: string,
              v: string,
            ) => {
              lt: (
                col: string,
                v: string,
              ) => PromiseLike<{ data: Record<string, string>[] | null }>;
            };
          };
        };
      };
    };
    const { data: purposes } = await raw
      .from("purpose_profiles")
      .select("user_id, status")
      .in("user_id", ids);
    const purposeByUser = new Map(
      (purposes ?? []).map((p) => [p.user_id, p.status === "submitted"]),
    );

    // Tests from the first contest week's Monday (it can start in September).
    const { data: tests } = await raw
      .from("activity_tests")
      .select("rep_id, taken_on")
      .in("rep_id", ids)
      .gte("taken_on", weekStartOfISO(month))
      .lt("taken_on", nextMonthStartISO(month));
    const testsByUser = new Map<string, string[]>();
    for (const t of tests ?? []) {
      const list = testsByUser.get(t.rep_id) ?? [];
      list.push(t.taken_on);
      testsByUser.set(t.rep_id, list);
    }

    const { data: countedSales } = await supabaseAdmin
      .from("contest_ledger")
      .select("rep_name")
      .eq("month", month)
      .eq("category", "money.sale")
      .neq("status", "cancelled");

    return {
      month,
      reps: (profiles ?? [])
        .filter((p) => p.is_active !== false)
        .map((p) => ({
          user_id: p.id,
          display_name: p.display_name ?? "",
          purpose_submitted: purposeByUser.get(p.id) ?? false,
          test_days: testsByUser.get(p.id) ?? [],
        }))
        .sort((a, b) => a.display_name.localeCompare(b.display_name)),
      counted_sale_reps: [...new Set((countedSales ?? []).map((r) => r.rep_name))],
    };
  });
