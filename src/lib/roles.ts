import type { AppRole } from "@/hooks/useAuth";

/** Manager tier: owner, captain, and office_staff (the "admin" role) all get full managerial access. */
export const MANAGER_ROLES: readonly AppRole[] = ["owner", "captain", "office_staff"] as const;

export function isManagerRole(role: AppRole | string | null | undefined): boolean {
  if (!role) return false;
  return (MANAGER_ROLES as readonly string[]).includes(role);
}
