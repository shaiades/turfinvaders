import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, setDevRoleOverride, type AppRole } from "@/hooks/useAuth";
import { LogOut, Trophy, Users, Settings, LayoutDashboard, ShieldCheck, ClipboardList, Inbox, Map, MapPin, FlaskConical } from "lucide-react";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, realRole, displayName } = useAuth();
  const router = useRouter();
  const isOverridden = role !== realRole && realRole !== null;

  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/teams", label: "Teams", icon: Users },
    { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
    ...(role === "canvasser" || role === "captain"
      ? [{ to: "/log", label: "Daily Log", icon: ClipboardList }]
      : []),
    ...(role === "canvasser"
      ? [{ to: "/my-territory", label: "My Territory", icon: MapPin }]
      : []),
    ...(role === "owner" || role === "captain"
      ? [{ to: "/territories", label: "Territories", icon: Map }]
      : []),
    ...(role === "owner" || role === "office_staff"
      ? [{ to: "/confirmation-desk", label: "Confirmation Desk", icon: Inbox }]
      : []),
    ...(role === "owner"
      ? [
          { to: "/users", label: "Players", icon: ShieldCheck },
          { to: "/settings", label: "Settings", icon: Settings },
        ]
      : []),
  ];

  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="min-h-screen flex flex-col">
      {user && (
        <div className="border-b border-[var(--neon-magenta)]/40 bg-[var(--neon-magenta)]/10 text-xs">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center gap-3 flex-wrap">
            <FlaskConical className="w-3.5 h-3.5 text-[var(--neon-magenta)]" />
            <span className="font-display uppercase tracking-widest text-[10px] text-[var(--neon-magenta)]">
              Dev Mode · View As
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
              <>
                <span className="text-muted-foreground">
                  (real role: <span className="text-foreground">{realRole}</span>)
                </span>
                <button
                  onClick={() => setDevRoleOverride(null)}
                  className="ml-auto text-[10px] uppercase tracking-widest text-[var(--neon-magenta)] hover:underline"
                >
                  Reset
                </button>
              </>
            )}
            <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">
              UI only · backend permissions unchanged
            </span>
          </div>
        </div>
      )}
      <header className="border-b border-border bg-surface/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center gap-6 px-4 sm:px-6 py-3">
          <Link to="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary text-primary-foreground grid place-items-center font-display text-[10px]">
              KN
            </div>
            <span className="font-display text-sm text-neon hidden sm:inline">KNOCK·OUT</span>
          </Link>
          <nav className="flex items-center gap-1 flex-1 overflow-x-auto">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="flex items-center gap-2 px-3 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                activeProps={{ className: "flex items-center gap-2 px-3 py-2 rounded-md text-sm text-primary bg-surface-elevated" }}
              >
                <item.icon className="w-4 h-4" />
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            ))}
          </nav>
          {user && (
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
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
            </div>
          )}
        </div>
      </header>
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">{children}</main>
    </div>
  );
}
