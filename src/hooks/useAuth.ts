import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { canUseViewAs, isAppRole, primaryRole, privilegeRole, type AppRole } from "@/lib/roles";

export type { AppRole };

export interface AuthState {
  loading: boolean;
  user: User | null;
  role: AppRole | null;
  realRole: AppRole | null;
  teamId: string | null;
  displayName: string | null;
  /** The profile's actual name, untouched by the View As rep picker. */
  realDisplayName: string | null;
  /** View As canvasser picker: the PREVIEWED canvasser's profile id, or null
   *  outside an owner's picked-canvasser preview. Canvasser data is id-keyed
   *  (daily_logs/earnings/ladder), so surfaces that show "my" canvasser data
   *  read `previewCanvasserId ?? user.id` — for READS ONLY. Write surfaces
   *  (time clock, desk log, goals, lead submit, badge persistence) must hide
   *  or disable instead: nothing may ever be written as the picked player. */
  previewCanvasserId: string | null;
  /** True only when the signed-in user's own profile is explicitly archived
   *  (is_active === false): they were removed from the roster, so the shell
   *  swaps the whole app for AccessRevokedScreen. Missing/failed profile
   *  reads stay false — lockout must never fire on a transient error. */
  accessRevoked: boolean;
}

export const DEV_ROLE_STORAGE_KEY = "dev_role_override";
// View As rep picker (owner request 2026-09-13): previewing "Sales Rep" as a
// SPECIFIC person. Close Kombat finds "you" by matching displayName against
// card-level rep names, so swapping the name IS the whole impersonation —
// data queries stay keyed to the owner's own user id, and the override only
// applies while the effective role is sales_rep (whose shell guard pins the
// app to /close-kombat), so canvasser surfaces that broadcast the name (crew
// map GPS) can never carry a borrowed one.
export const DEV_NAME_STORAGE_KEY = "dev_name_override";
// View As canvasser picker (owner request 2026-10-06): previewing "Canvasser"
// as a SPECIFIC person — the Close Kombat rep picker's twin. Canvasser
// surfaces key on the profile ID (not the display name), so the pick stores
// BOTH: the name drives labels, the id drives read-only data swaps via
// previewCanvasserId. Only honored while an owner's effective role is
// canvasser; CrewBeacon stays silent in previews (publisher gate is on the
// REAL role) so the borrowed name can never broadcast.
export const DEV_CANVASSER_STORAGE_KEY = "dev_canvasser_override";

export type CanvasserPick = { id: string; name: string };

function readDevRole(): AppRole | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(DEV_ROLE_STORAGE_KEY);
  return isAppRole(v) ? v : null;
}

function readDevName(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(DEV_NAME_STORAGE_KEY);
  return v && v.trim() ? v.trim() : null;
}

function readDevCanvasser(): CanvasserPick | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DEV_CANVASSER_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<CanvasserPick> | null;
    if (!v || typeof v.id !== "string" || !v.id || typeof v.name !== "string" || !v.name.trim())
      return null;
    return { id: v.id, name: v.name.trim() };
  } catch {
    return null;
  }
}

/** The name override, gated the same way readDevRole's consumer is: owner
 *  only, and only inside a Sales Rep preview. */
function effectiveDevName(realRole: AppRole | null, effRole: AppRole | null): string | null {
  if (!canUseViewAs(realRole) || effRole !== "sales_rep") return null;
  return readDevName();
}

/** The canvasser pick, gated like the rep name override: owner only, and
 *  only inside a Canvasser preview — a stale key must never leak elsewhere. */
function effectiveCanvasserPick(
  realRole: AppRole | null,
  effRole: AppRole | null,
): CanvasserPick | null {
  if (!canUseViewAs(realRole) || effRole !== "canvasser") return null;
  return readDevCanvasser();
}

// useAuth has no provider: AppShell, the page, ActiveRun, CrewBeacon, … each
// mount their own copy, and each used to fire its own auth.getUser() network
// validation plus a roles + profile read — 4× the same three requests
// serialized ahead of the map's first paint. Share one in-flight getUser and
// one short-lived roles/profile fetch across all mounts instead. TTL is
// seconds: role grants are rare admin ops, and every auth event still
// re-hydrates through the same path.
let sharedGetUser: ReturnType<typeof supabase.auth.getUser> | null = null;
function getUserShared() {
  if (!sharedGetUser) {
    sharedGetUser = supabase.auth.getUser();
    void sharedGetUser.finally(() => {
      sharedGetUser = null;
    });
  }
  return sharedGetUser;
}

type HydrateFetch = Promise<{
  roles: Array<{ role: string }> | null;
  profile: { team_id: string | null; display_name: string | null; is_active: boolean | null } | null;
}>;
let rolesProfileCache: { uid: string; at: number; promise: HydrateFetch } | null = null;
const ROLES_PROFILE_TTL_MS = 15_000;
function fetchRolesProfile(uid: string): HydrateFetch {
  const now = Date.now();
  if (
    rolesProfileCache &&
    rolesProfileCache.uid === uid &&
    now - rolesProfileCache.at < ROLES_PROFILE_TTL_MS
  ) {
    return rolesProfileCache.promise;
  }
  const promise = Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", uid),
    supabase.from("profiles").select("team_id, display_name, is_active").eq("id", uid).maybeSingle(),
  ]).then(([{ data: roles }, { data: profile }]) => ({ roles, profile }));
  rolesProfileCache = { uid, at: now, promise };
  return promise;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    role: null,
    realRole: null,
    teamId: null,
    displayName: null,
    realDisplayName: null,
    previewCanvasserId: null,
    accessRevoked: false,
  });

  useEffect(() => {
    let active = true;

    async function hydrate(user: User | null) {
      if (!user) {
        if (active)
          setState({
            loading: false,
            user: null,
            role: null,
            realRole: null,
            teamId: null,
            displayName: null,
            realDisplayName: null,
            previewCanvasserId: null,
            accessRevoked: false,
          });
        return;
      }
      const { roles, profile } = await fetchRolesProfile(user.id);
      const r = roles?.map((x) => x.role as AppRole) ?? [];
      const realRole = primaryRole(r);
      // View As is owner-only (owner decision 2026-08-12): a stale
      // dev_role_override left in this browser's localStorage must never
      // re-skin anyone but an owner — captains included.
      const override = canUseViewAs(realRole) ? readDevRole() : null;
      const effRole = privilegeRole(override ?? realRole);
      const realDisplayName = profile?.display_name ?? user.email ?? null;
      const canvasserPick = effectiveCanvasserPick(realRole, effRole);
      if (active) {
        setState({
          loading: false,
          user,
          // `role` drives experience (nav, guards, HUD) and is collapsed to
          // its privilege tier: confirmers live the canvasser app.
          // `realRole` stays raw for labels and the owner-only tier checks.
          role: effRole,
          realRole,
          teamId: profile?.team_id ?? null,
          displayName:
            effectiveDevName(realRole, effRole) ?? canvasserPick?.name ?? realDisplayName,
          realDisplayName,
          previewCanvasserId: canvasserPick?.id ?? null,
          // Explicit false only — a null/missing profile (placeholder claim
          // in flight, transient read failure) must not read as removed.
          accessRevoked: profile?.is_active === false,
        });
      }
    }

    getUserShared().then(({ data }) => hydrate(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      hydrate(session?.user ?? null);
    });

    // Listen for View As override changes (role or rep name) from this tab
    // or others.
    function onOverride() {
      setState((s) => {
        const override = canUseViewAs(s.realRole) ? readDevRole() : null;
        const effRole = privilegeRole(override ?? s.realRole);
        const canvasserPick = effectiveCanvasserPick(s.realRole, effRole);
        return {
          ...s,
          role: effRole,
          displayName:
            effectiveDevName(s.realRole, effRole) ?? canvasserPick?.name ?? s.realDisplayName,
          previewCanvasserId: canvasserPick?.id ?? null,
        };
      });
    }
    window.addEventListener("dev-role-changed", onOverride);
    window.addEventListener("storage", (e) => {
      if (
        e.key === DEV_ROLE_STORAGE_KEY ||
        e.key === DEV_NAME_STORAGE_KEY ||
        e.key === DEV_CANVASSER_STORAGE_KEY
      )
        onOverride();
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
      window.removeEventListener("dev-role-changed", onOverride);
    };
  }, []);

  return state;
}

export function setDevRoleOverride(role: AppRole | null) {
  if (typeof window === "undefined") return;
  if (role !== null && !isAppRole(role)) return;
  if (role) window.localStorage.setItem(DEV_ROLE_STORAGE_KEY, role);
  else window.localStorage.removeItem(DEV_ROLE_STORAGE_KEY);
  window.dispatchEvent(new Event("dev-role-changed"));
}

export function setDevNameOverride(name: string | null) {
  if (typeof window === "undefined") return;
  const v = name?.trim() || null;
  if (v) window.localStorage.setItem(DEV_NAME_STORAGE_KEY, v);
  else window.localStorage.removeItem(DEV_NAME_STORAGE_KEY);
  // Same event as the role override: one listener recomputes both.
  window.dispatchEvent(new Event("dev-role-changed"));
}

export function setDevCanvasserOverride(pick: CanvasserPick | null) {
  if (typeof window === "undefined") return;
  const v = pick && pick.id && pick.name.trim() ? { id: pick.id, name: pick.name.trim() } : null;
  if (v) window.localStorage.setItem(DEV_CANVASSER_STORAGE_KEY, JSON.stringify(v));
  else window.localStorage.removeItem(DEV_CANVASSER_STORAGE_KEY);
  window.dispatchEvent(new Event("dev-role-changed"));
}
