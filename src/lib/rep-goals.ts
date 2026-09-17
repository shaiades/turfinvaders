// Sales-rep weekly sales-count back-solve (owner, 2026-09-17). Separate from
// funnel.ts on purpose: that engine is door-based and income-based, built for
// canvassers who knock doors for leads. Reps don't knock doors — they take
// sits and close them — so their funnel is one step shorter: a sales goal
// walks back through closePct to sits needed, then through sitPct to appts
// needed. Never invents a number when the rates can't support the math,
// mirroring funnel.ts's backSolveFunnel null-return contract.
//
// Pure module: no imports, unit-testable like funnel.ts and close-kombat.ts.

export type RepFunnelBackSolve = {
  requiredSits: number;
  requiredAppts: number;
};

export function backSolveRepFunnel({
  salesGoal,
  closePct,
  sitPct,
}: {
  salesGoal: number;
  closePct: number | null;
  sitPct: number | null;
}): RepFunnelBackSolve | null {
  if (salesGoal <= 0) return null;
  if (closePct === null || closePct <= 0) return null;
  if (sitPct === null || sitPct <= 0) return null;
  const requiredSits = salesGoal / closePct;
  const requiredAppts = requiredSits / sitPct;
  return { requiredSits, requiredAppts };
}
