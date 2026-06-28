import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";

export type AppRole = "owner" | "office_staff" | "captain" | "canvasser";

export interface AuthState {
  loading: boolean;
  user: User | null;
  role: AppRole | null;
  realRole: AppRole | null;
  teamId: string | null;
  displayName: string | null;
}

export const DEV_ROLE_STORAGE_KEY = "dev_role_override";

function readDevRole(): AppRole | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(DEV_ROLE_STORAGE_KEY);
  if (v === "owner" || v === "office_staff" || v === "captain" || v === "canvasser") return v;
  return null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true, user: null, role: null, realRole: null, teamId: null, displayName: null,
  });

  useEffect(() => {
    let active = true;

    async function hydrate(user: User | null) {
      if (!user) {
        if (active) setState({ loading: false, user: null, role: null, realRole: null, teamId: null, displayName: null });
        return;
      }
      const [{ data: roles }, { data: profile }] = await Promise.all([
        supabase.from("user_roles").select("role").eq("user_id", user.id),
        supabase.from("profiles").select("team_id, display_name").eq("id", user.id).maybeSingle(),
      ]);
      // priority owner > captain > canvasser
      const r = roles?.map((x) => x.role as AppRole) ?? [];
      const realRole: AppRole | null =
        r.includes("owner") ? "owner"
        : r.includes("office_staff") ? "office_staff"
        : r.includes("captain") ? "captain"
        : r.includes("canvasser") ? "canvasser" : null;
      const override = readDevRole();
      if (active) {
        setState({
          loading: false,
          user,
          role: override ?? realRole,
          realRole,
          teamId: profile?.team_id ?? null,
          displayName: profile?.display_name ?? user.email ?? null,
        });
      }
    }

    supabase.auth.getUser().then(({ data }) => hydrate(data.user));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      hydrate(session?.user ?? null);
    });

    // Listen for dev-role override changes from this tab or others.
    function onOverride() {
      setState((s) => ({ ...s, role: readDevRole() ?? s.realRole }));
    }
    window.addEventListener("dev-role-changed", onOverride);
    window.addEventListener("storage", (e) => {
      if (e.key === DEV_ROLE_STORAGE_KEY) onOverride();
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
  if (role) window.localStorage.setItem(DEV_ROLE_STORAGE_KEY, role);
  else window.localStorage.removeItem(DEV_ROLE_STORAGE_KEY);
  window.dispatchEvent(new Event("dev-role-changed"));
}

