import { Link, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { LogOut, Trophy, Users, Settings, LayoutDashboard, ShieldCheck, ClipboardList, Inbox } from "lucide-react";

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, displayName } = useAuth();
  const router = useRouter();

  const navItems = [
    { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { to: "/teams", label: "Teams", icon: Users },
    { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
    ...(role === "canvasser" || role === "captain"
      ? [{ to: "/log", label: "Daily Log", icon: ClipboardList }]
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
