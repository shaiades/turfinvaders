/** Pure role/permission vocabulary — no supabase, no router imports, so both
 *  browser code and server functions share one source of truth. Route-guard
 *  helpers that need the supabase client live in roles.ts, which re-exports
 *  everything here. */

/** All app roles, in priority order (highest first). sales_rep (closers,
 *  added 2026-07-29 for Close Kombat) sits above canvasser: a rep sees only
 *  their stats section, never the canvassing suite. */
export const APP_ROLES = ["owner", "office_staff", "captain", "sales_rep", "canvasser"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export function isAppRole(v: unknown): v is AppRole {
  return (APP_ROLES as readonly unknown[]).includes(v);
}

/** Manager tier: owner, captain, and office_staff (the "admin" role) all get full managerial access. */
export const MANAGER_ROLES: readonly AppRole[] = ["owner", "captain", "office_staff"] as const;

export function isManagerRole(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (MANAGER_ROLES as readonly string[]).includes(role);
}

/** Admin tier: owner and office_staff ONLY — captains are deliberately
 *  excluded. Gates the owner dashboard, the confirmation desk, and
 *  admin-only editing. Never widen a check from this to MANAGER_ROLES. */
export const ADMIN_ROLES: readonly AppRole[] = ["owner", "office_staff"] as const;

export function isAdminRole(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

/** Close Kombat (sales-rep stats): owner, office_staff, and the reps
 *  themselves — captains deliberately excluded (owner decision 2026-07-29).
 *  Gates the /close-kombat route; block_cards RLS mirrors this list. */
export const CLOSE_KOMBAT_ROLES: readonly AppRole[] = [
  "owner",
  "office_staff",
  "sales_rep",
] as const;

/** Highest-priority role held: owner > office_staff > captain > sales_rep >
 *  canvasser; null when none of the app roles are present. */
export function primaryRole(roles: ReadonlyArray<AppRole | string>): AppRole | null {
  for (const r of APP_ROLES) if (roles.includes(r)) return r;
  return null;
}

/** Roles a non-owner manager (captain / office_staff) may grant or create.
 *  Mirrors the set_user_role RPC and the createCanvasser server rule — keep
 *  all three in lockstep. */
export const LIMITED_ASSIGNABLE_ROLES: readonly AppRole[] = [
  "captain",
  "sales_rep",
  "canvasser",
] as const;

/** Roles this actor may offer in a role dropdown or Add-Player form. */
export function assignableRolesFor(actor: AppRole | string | null | undefined): readonly AppRole[] {
  if (actor === "owner") return APP_ROLES;
  if (actor === "captain" || actor === "office_staff") return LIMITED_ASSIGNABLE_ROLES;
  return [];
}

/** May `actor` modify/delete an account holding `targetRoles`? Owners:
 *  always. Captains/office_staff: only non-privileged targets (no owner, no
 *  office_staff). Last-owner protection is a separate check. */
export function canManageTarget(
  actor: AppRole | string | null | undefined,
  targetRoles: ReadonlyArray<AppRole | string>,
): boolean {
  if (actor === "owner") return true;
  if (actor === "captain" || actor === "office_staff") {
    return !targetRoles.some((r) => isAdminRole(r));
  }
  return false;
}

/** Roles `actor` may preview via the View As override. Admins preview
 *  anything; captains only their own tier and below — never an owner/admin
 *  skin. Applied both where the option list renders (AppShell) and where the
 *  stored override is resolved (useAuth), so a stale localStorage value
 *  can't re-skin a captain after their options were narrowed. */
export function canPreviewRole(
  actor: AppRole | string | null | undefined,
  target: AppRole,
): boolean {
  if (isAdminRole(actor)) return true;
  if (actor === "captain") return target === "captain" || target === "canvasser";
  return false;
}

/** Display labels/badge tones — shared by RosterPanel, Manage Players, and
 *  the Permissions tab. office_staff surfaces as "Admin". */
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Owner",
  office_staff: "Admin",
  captain: "Captain",
  sales_rep: "Sales Rep",
  canvasser: "Canvasser",
};

export const ROLE_TONE: Record<AppRole, string> = {
  owner: "text-victory border-victory/40",
  office_staff: "text-accent border-accent/40",
  captain: "text-neon border-neon/40",
  sales_rep: "text-warning border-warning/40",
  canvasser: "text-muted-foreground border-border",
};

export type AccessLevel = "yes" | "team" | "self" | "no";

export type AccessArea = {
  key: string;
  label: string;
  note?: string;
  access: Record<AppRole, AccessLevel>;
};

function grant(
  allowed: readonly AppRole[],
  overrides: Partial<Record<AppRole, AccessLevel>> = {},
): Record<AppRole, AccessLevel> {
  const out = {} as Record<AppRole, AccessLevel>;
  for (const r of APP_ROLES) out[r] = overrides[r] ?? (allowed.includes(r) ? "yes" : "no");
  return out;
}

/** Role → access matrix shown on the Permissions tab. Derived from the tier
 *  constants above so a tier change updates the matrix automatically; the
 *  overrides encode the scoped exceptions (team/self reads). */
export const ACCESS_MATRIX: readonly AccessArea[] = [
  {
    key: "command",
    label: "Command Dashboard (Executive / Timesheets)",
    access: grant(ADMIN_ROLES),
  },
  {
    key: "payroll",
    label: "Payroll",
    note: "Captains can view their own team's paychecks only — no payroll editing for anyone but Owners.",
    access: grant(ADMIN_ROLES, { captain: "team", canvasser: "self" }),
  },
  {
    key: "desk",
    label: "Confirmation Desk",
    access: grant(ADMIN_ROLES),
  },
  {
    key: "close_kombat",
    label: "Close Kombat (sales-rep stats)",
    access: grant(CLOSE_KOMBAT_ROLES),
  },
  {
    key: "canvassing",
    label: "Canvassing data — all teams",
    note: "Dispatch board, logs, leads, pins, and territories across every van.",
    access: grant(MANAGER_ROLES, { canvasser: "self" }),
  },
  {
    key: "fleet",
    label: "Fleet Dispatch — assign people to vans",
    access: grant(MANAGER_ROLES),
  },
  {
    key: "players",
    label: "Manage Players — add/delete users, assign roles",
    note: "Captains and Admins assign Canvasser, Sales Rep, or Captain only, and cannot touch Owner/Admin accounts.",
    access: grant(MANAGER_ROLES),
  },
  {
    key: "owner_only",
    label: "Grant Owner/Admin · delete vans · edit payroll",
    access: grant(["owner"]),
  },
  {
    key: "field",
    label: "Field tools (Active Run, Territory, Log, Wrap)",
    access: grant([...MANAGER_ROLES, "canvasser"]),
  },
];
