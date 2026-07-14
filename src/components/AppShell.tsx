import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, setDevRoleOverride, type AppRole } from "@/hooks/useAuth";
import { LogOut, Users, Settings, LayoutDashboard, ShieldCheck, ClipboardList, Inbox, MapPin, FlaskConical, DollarSign, Trophy, Zap, Flame } from "lucide-react";
import turfInvadersWordmark from "@/assets/turf-invaders-wordmark.png.asset.json";

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  search?: Record<string, string>;
};

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, realRole, displayName } = useAuth();
  const router = useRouter();
  const isOverridden = role !== realRole && realRole !== null;

  const navItems: NavItem[] = (() => {
    if (role === "owner") {
      return [
        { to: "/dashboard", search: { tab: "executive" }, label: "Command", icon: LayoutDashboard },
        { to: "/my-territory", label: "Territory", icon: MapPin },
        { to: "/dashboard", search: { tab: "dispatch" }, label: "Dispatch", icon: Inbox },
        { to: "/dashboard", search: { tab: "fleet" }, label: "Fleet", icon: Users },
        { to: "/dashboard", search: { tab: "payroll" }, label: "Payroll", icon: DollarSign },
        { to: "/daily-wrap", label: "Wrap-Up", icon: Flame },
      ];
    }
    if (role === "canvasser") {
      return [
        { to: "/field", label: "Active Run", icon: Zap },
        { to: "/dashboard", label: "Command", icon: LayoutDashboard },
        { to: "/my-territory", label: "Territory", icon: MapPin },
      ];
    }
    if (role === "captain") {
      return [
        { to: "/field", label: "Active Run", icon: Zap },
        { to: "/dashboard", label: "Command", icon: LayoutDashboard },
        { to: "/my-territory", label: "Territory", icon: MapPin },
        { to: "/teams", label: "My Van", icon: Users },
        { to: "/leaderboard", label: "Leaders", icon: Trophy },
        { to: "/daily-wrap", label: "Wrap-Up", icon: Flame },
        { to: "/log", label: "Log", icon: ClipboardList },
      ];
    }
    if (role === "office_staff") {
      return [
        { to: "/dashboard", label: "Command", icon: LayoutDashboard },
        { to: "/dashboard", search: { tab: "dispatch" }, label: "Dispatch", icon: Inbox },
        { to: "/confirmation-desk", label: "Desk", icon: ShieldCheck },
      ];
    }
    return [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }];
  })();


  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {user && (
        <div className="border-b border-[var(--neon-magenta)]/30 bg-background text-xs">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3 flex-wrap">
            <FlaskConical className="w-3.5 h-3.5 text-[var(--neon-magenta)]" />
            <span className="font-display uppercase tracking-widest text-[10px] text-[var(--neon-magenta)]">
              Dev · View As
            </span>
            <select
              value={role ?? ""}
              onChange={(e) => {
                const v = e.target.value as AppRole;
                setDevRoleOverride(v === realRole ? null : v);
              }}
              className="bg-surface border border-border rounded px-2 py-1 text-xs font-medium focus:outline-none focus:ring-1 focus:ring-[var(--neon-magenta)]"
            >
              <option value="owner">Owner</option>
              <option value="captain">Captain</option>
              <option value="canvasser">Canvasser</option>
              <option value="office_staff">Office Staff</option>
            </select>
            {isOverridden && (
              <button
                onClick={() => setDevRoleOverride(null)}
                className="ml-auto text-[10px] uppercase tracking-widest text-[var(--neon-magenta)] hover:underline"
              >
                Reset to {realRole}
              </button>
            )}
          </div>
        </div>
      )}
      <header className="border-b border-border bg-background/95 backdrop-blur sticky top-0 z-20">
        {/* Mobile header: centered logo only */}
        <div className="md:hidden flex items-center justify-between px-4 py-2">
          <div className="w-9" />
          <Link to="/dashboard" aria-label="Turf Invaders home" className="flex items-center justify-center">
            <img
              src={turfInvadersWordmark.url}
              alt="Turf Invaders"
              style={{ maxHeight: 40 }}
              className="h-10 w-auto object-contain drop-shadow-[0_0_10px_color-mix(in_oklab,var(--neon)_55%,transparent)]"
            />
          </Link>
          {user ? (
            <button
              onClick={signOut}
              className="p-2 rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
              aria-label="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-9" />
          )}
        </div>
        {/* Desktop header: nav + centered logo + user */}
        <div className="hidden md:grid max-w-7xl mx-auto grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 sm:px-6 py-3">
          <nav className="flex items-center gap-1 overflow-x-auto justify-start">
            {navItems.map((item) => (
              <Link
                key={`${item.to}-${item.label}`}
                to={item.to}
                search={item.search as never}
                activeOptions={{ includeSearch: !!item.search, exact: !item.search }}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                activeProps={{
                  className:
                    "flex items-center gap-2 px-3 py-2 rounded-md text-sm text-primary bg-surface-elevated ring-1 ring-primary/40",
                }}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <Link to="/dashboard" className="flex items-center justify-center shrink-0" aria-label="Turf Invaders home">
            <img
              src={turfInvadersWordmark.url}
              alt="Turf Invaders"
              style={{ maxHeight: 40 }}
              className="h-10 w-auto object-contain drop-shadow-[0_0_14px_color-mix(in_oklab,var(--neon)_55%,transparent)]"
            />
          </Link>
          <div className="flex items-center gap-3 justify-end">
            {user && (
              <>
                <div className="text-right">
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">{role}</div>
                  <div className="text-sm font-medium">{displayName}</div>
                </div>
                <button
                  onClick={signOut}
                  className="p-2 rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 md:py-8 pb-28 md:pb-8">{children}</main>

      {/* Mobile bottom tab bar */}
      {user && (
        <nav
          aria-label="Primary"
          className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <ul className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(navItems.length, 5)}, minmax(0, 1fr))` }}>
            {navItems.slice(0, 5).map((item) => (
              <li key={`bt-${item.to}-${item.label}`}>
                <Link
                  to={item.to}
                  search={item.search as never}
                  activeOptions={{ includeSearch: !!item.search, exact: !item.search }}
                  className="flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-display uppercase tracking-wider text-muted-foreground min-h-14"
                  activeProps={{
                    className:
                      "flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-display uppercase tracking-wider text-primary min-h-14",
                  }}
                >
                  <item.icon className="w-5 h-5" />
                  <span className="truncate max-w-full px-1">{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
