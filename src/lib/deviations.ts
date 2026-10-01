// The "What Changed" engine (owner directive 2026-10-01): management by
// exception. PURE detectors — the server fn feeds them aggregates, the
// page and the 6:45am digest consume the same ranked output. Every
// threshold is AND-gated (magnitude AND base-rate AND denominator): a
// detector that fires on noise trains the owner to ignore the brief.

export type Deviation = {
  key: string;
  /** One sentence, numbers first — reads identically on page and push. */
  line: string;
  sub?: string;
  /** Estimated $ impact for ranking (0 = rank by order of detector). */
  dollars: number;
  /** In-app destination. */
  to: string;
};

const round0 = (n: number) => Math.round(n);
const pct = (n: number) => `${Math.round(n * 100)}%`;

// ── 1 · Van lead sag — leads/active-day, current week vs 4-wk baseline ──
export function detectVanLeadSag(
  vans: Array<{
    name: string;
    /** Per-active-day over the previous 4 FULL Mon–Sun weeks. */
    baselinePerDay: number;
    /** Per-active-day this week, through today. */
    currentPerDay: number;
    activeDaysThisWeek: number;
    /** Rough $ a lead is worth (for ranking only). */
    leadValue: number;
  }>,
): Deviation[] {
  const out: Deviation[] = [];
  for (const v of vans) {
    if (v.baselinePerDay < 4) continue; // low-volume van: a dip isn't signal
    if (v.activeDaysThisWeek < 2) continue; // one day proves nothing
    const delta = (v.currentPerDay - v.baselinePerDay) / v.baselinePerDay;
    if (Math.abs(delta) < 0.3) continue;
    out.push({
      key: `van-sag:${v.name}`,
      line: `${v.name}: ${v.baselinePerDay.toFixed(1)} leads/day (4-wk) → ${v.currentPerDay.toFixed(1)} this week, ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`,
      dollars: round0(Math.abs(v.baselinePerDay - v.currentPerDay) * 5 * v.leadValue),
      to: "/teams",
    });
  }
  return out;
}

// ── 2 · Rep close-rate collapse — trailing 14d vs 8-wk baseline ─────────
export function detectRepCloseCollapse(
  reps: Array<{
    name: string;
    baseSits: number;
    baseSold: number;
    curSits: number;
    curSold: number;
    avgTicket: number;
  }>,
): Deviation[] {
  const out: Deviation[] = [];
  for (const r of reps) {
    if (r.curSits < 8 || r.baseSits < 8) continue;
    const base = r.baseSold / r.baseSits;
    const cur = r.curSold / r.curSits;
    const dropAbs = base - cur;
    if (dropAbs < 0.12) continue; // ≥12 points absolute…
    if (dropAbs / Math.max(base, 0.01) < 0.4) continue; // …AND ≥40% relative
    out.push({
      key: `rep-close:${r.name}`,
      line: `${r.name}: close ${pct(base)} → ${pct(cur)} on ${r.curSits} sits last 2 wks`,
      dollars: round0(dropAbs * r.curSits * r.avgTicket),
      to: "/close-kombat?tab=stats",
    });
  }
  return out;
}

// ── 3 · Office cancel spike — MTD vs the prior 3 full months ────────────
export function detectOfficeCancelSpike(
  offices: Array<{
    office: string;
    mtdCancel: number;
    mtdGross: number;
    baselinePct: number | null;
  }>,
): Deviation[] {
  const out: Deviation[] = [];
  for (const o of offices) {
    if (o.baselinePct === null || o.mtdGross <= 0) continue;
    const cur = o.mtdCancel / o.mtdGross;
    if (cur - o.baselinePct < 0.04) continue; // ≥ +4 pts…
    if (o.mtdCancel < 50_000) continue; // …AND real dollars walking
    out.push({
      key: `cancel-spike:${o.office}`,
      line: `${o.office} cancels: ${(cur * 100).toFixed(1)}% of book vs ${(o.baselinePct * 100).toFixed(1)}% 3-mo avg — ${fmtK(o.mtdCancel)} walking`,
      dollars: round0(o.mtdCancel),
      to: "/close-kombat?tab=stats",
    });
  }
  return out;
}

// ── 4 · Doors-per-rep sag — this week vs 4-wk, era-gated ─────────────────
export function detectDoorSag(input: {
  baselinePerRepDay: number;
  currentPerRepDay: number;
  baselineWeeks: number;
  dollarPerDoor: number;
}): Deviation[] {
  if (input.baselineWeeks < 3) return []; // doors era too young to judge
  if (input.baselinePerRepDay < 50) return [];
  const delta = (input.currentPerRepDay - input.baselinePerRepDay) / input.baselinePerRepDay;
  if (Math.abs(delta) < 0.25) return [];
  return [
    {
      key: "door-sag",
      line: `Doors/rep: ${Math.round(input.baselinePerRepDay)}/day (4-wk) → ${Math.round(input.currentPerRepDay)} this week, ${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}%`,
      dollars: round0(
        Math.abs(input.baselinePerRepDay - input.currentPerRepDay) * 5 * input.dollarPerDoor,
      ),
      to: "/dashboard?tab=dispatch",
    },
  ];
}

// ── 5 · Payment aging — crossed 14 days past due WITHIN the last 7 ──────
// Stateless re-fire guard: a payment alerts the week it crosses the line,
// then leaves the brief (it stays in the receipts drawer + aging buckets).
export function detectPaymentAging(
  rows: Array<{
    customer: string | null;
    remaining: number;
    anticipated_date: string | null;
  }>,
  todayISO: string,
): Deviation[] {
  const out: Deviation[] = [];
  const DAY = 86_400_000;
  const today = Date.parse(todayISO);
  for (const r of rows) {
    if (r.remaining <= 0 || r.anticipated_date === null) continue;
    const late = Math.round((today - Date.parse(r.anticipated_date)) / DAY);
    if (late < 14 || late >= 21) continue;
    out.push({
      key: `aging:${r.customer ?? "?"}:${r.anticipated_date}`,
      line: `${r.customer ?? "Unnamed payment"}: ${fmtK(r.remaining)} now ${late} days past due`,
      dollars: round0(r.remaining),
      to: "/god-mode",
    });
  }
  return out;
}

/** Rank by estimated dollars, cap the brief — five lines or silence. */
export function rankDeviations(all: Deviation[], max = 5): Deviation[] {
  return [...all].sort((a, b) => b.dollars - a.dollars).slice(0, max);
}

const fmtK = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : Math.abs(n) >= 1_000
      ? `$${Math.round(n / 1_000)}K`
      : `$${Math.round(n)}`;

// ── Digest composition (page engine → 5 push lines, verbatim) ───────────

export type DigestFacts = {
  yesterday: { banked: number; soldBook: number; leads: number; doors: number };
  today: { dueAmount: number; duePayments: number; overdueBacklog: number };
  deviations: Deviation[];
  /** Flagged punches ≥7 days old join the digest daily until cleared. */
  staleFlaggedPunches: { count: number; oldestDays: number } | null;
};

export function composeDigest(f: DigestFacts): { title: string; body: string } {
  const lines: string[] = [];
  lines.push(
    `Yesterday: ${fmtK(f.yesterday.banked)} banked · ${fmtK(f.yesterday.soldBook)} sold · ${f.yesterday.leads} leads · ${f.yesterday.doors.toLocaleString()} doors`,
  );
  lines.push(
    `Today: ${fmtK(f.today.dueAmount)} due (${f.today.duePayments} payment${f.today.duePayments === 1 ? "" : "s"})${
      f.today.overdueBacklog > 0 ? ` · ${fmtK(f.today.overdueBacklog)} overdue backlog` : ""
    }`,
  );
  // The ≥7-day punches escalation re-appears EVERY morning until cleared —
  // it owns a slot and is never crowded out by deviations.
  const punchLine =
    f.staleFlaggedPunches && f.staleFlaggedPunches.count > 0
      ? `${f.staleFlaggedPunches.count} flagged punches still open · oldest ${f.staleFlaggedPunches.oldestDays}d`
      : null;
  const extras: string[] = f.deviations.slice(0, punchLine ? 2 : 3).map((d) => d.line);
  if (punchLine) extras.push(punchLine);
  if (extras.length === 0) {
    lines.push("No deviations.");
  } else {
    lines.push(...extras.slice(0, 3));
  }
  return { title: "God Mode · morning brief", body: lines.join("\n") };
}
