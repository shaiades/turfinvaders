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

/** Daily Gratitude Gate on My Territory: canvassers AND captains do the
 *  check-in — they work the field (owner decision 2026-08-19). Owners,
 *  Admins, and sales reps skip straight to the map. Not a manager/admin
 *  tier — don't swap this list for one of those. */
export const GRATITUDE_GATE_ROLES: readonly AppRole[] = ["canvasser", "captain"] as const;

export function requiresGratitudeGate(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (GRATITUDE_GATE_ROLES as readonly string[]).includes(role);
}

/** Highest-priority role held: owner > office_staff > captain > sales_rep >
 *  canvasser; null when none of the app roles are present. */
export function primaryRole(roles: ReadonlyArray<AppRole | string>): AppRole | null {
  for (const r of APP_ROLES) if (roles.includes(r)) return r;
  return null;
}

/** Starting roles a non-owner manager (captain / office_staff) may give a
 *  BRAND-NEW account. Mirrors the createCanvasser/addTeamMember server rule —
 *  keep them in lockstep. Changing an EXISTING account's role is owner-only
 *  (set_user_role RPC, owner decision 2026-08-12). */
export const LIMITED_CREATABLE_ROLES: readonly AppRole[] = ["canvasser", "sales_rep"] as const;

/** Roles this actor may offer when CHANGING an existing account's role.
 *  Owner-only (owner decision 2026-08-12) — mirrors the set_user_role RPC;
 *  captains/Admins get an empty list and must never render a role dropdown. */
export function assignableRolesFor(actor: AppRole | string | null | undefined): readonly AppRole[] {
  if (actor === "owner") return APP_ROLES;
  return [];
}

/** Roles this actor may pick when CREATING a brand-new account (Add Player /
 *  Add Team Member). Owners: any role, including additional Owners. Captains
 *  and Admins: canvasser tier only. */
export function creatableRolesFor(actor: AppRole | string | null | undefined): readonly AppRole[] {
  if (actor === "owner") return APP_ROLES;
  if (actor === "captain" || actor === "office_staff") return LIMITED_CREATABLE_ROLES;
  return [];
}

/** May `actor` modify/delete an account holding `targetRoles`? Owners:
 *  always. Captains/office_staff: only non-privileged targets (no owner, no
 *  office_staff). Last-owner protection is a separate check. Gates team,
 *  suspension, move, and archive controls — NOT role changes (owner-only). */
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

/** View As is an owner-only tool (owner decision 2026-08-12: it must never
 *  appear on a captain's or Admin's screen). Applied both where the bar
 *  renders (AppShell) and where the stored override is resolved (useAuth), so
 *  a stale localStorage value can't re-skin anyone but an owner. */
export function canUseViewAs(role: AppRole | string | null | undefined): boolean {
  return role === "owner";
}

/** Display labels/badge tones — shared by RosterPanel and Manage Players. */
// office_staff renders as "Manager" (owner decision 2026-08-14): the chain of
// command reads Owner → Manager → Captain. The enum value stays office_staff —
// it's baked into user_roles rows and RLS policies; only the label changed.
export const ROLE_LABEL: Record<AppRole, string> = {
  owner: "Owner",
  office_staff: "Manager",
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
