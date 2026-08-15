import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, setDevRoleOverride, type AppRole } from "@/hooks/useAuth";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { CanvasserHUD } from "@/components/CanvasserHUD";
import { CLOSE_KOMBAT_ROLES, canUseViewAs } from "@/lib/roles";
import {
  LogOut,
  LayoutDashboard,
  MapPin,
  FlaskConical,
  DollarSign,
  Zap,
  Trophy,
  Target,
  PhoneCall,
  Sparkles,
  Truck,
  Swords,
} from "lucide-react";
const turfInvadersWordmark = { url: "/turf-invaders-wordmark.png" };

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  search?: Record<string, string>;
};

// Routes a Canvasser is allowed to visit. Anything else → redirect to /field.
// /dashboard is the Mission page (Plan/Log/Stats merged, 2026-08-14).
// /log MUST stay here even though canvassers get redirected off it — the
// guard below fires on pathname before the route's own <Navigate> runs, so
// dropping it would bounce old /log bookmarks to /field instead of the Log
// tab. /playbook redirects in beforeLoad (throws before the location
// commits), so it can stay off this list.
const CANVASSER_ALLOWED = ["/field", "/my-territory", "/dashboard", "/log", "/leaderboard", "/daily-wrap"];

// Sales reps (closers) get exactly one screen: Close Kombat (owner decision
// 2026-07-29). Anything else → redirect there.
const SALES_REP_ALLOWED = ["/close-kombat"];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, realRole, displayName } = useAuth();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isOverridden = role !== realRole && realRole !== null;

  // Canvasser guard: block manual navigation to leadership routes.
  useEffect(() => {
    if (role !== "canvasser") return;
    const allowed = CANVASSER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!allowed) {
      router.navigate({ to: "/field", replace: true });
    }
  }, [role, pathname, router]);

  // Sales-rep guard: their whole app is Close Kombat. Only force-navigate
  // when the REAL roles can actually enter /close-kombat — its beforeLoad
  // checks user_roles, so pushing e.g. a captain preview there would bounce
  // back to /dashboard and loop forever.
  useEffect(() => {
    if (role !== "sales_rep") return;
    if (!realRole || !CLOSE_KOMBAT_ROLES.includes(realRole)) return;
    const allowed = SALES_REP_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + "/"));
    if (!allowed) {
      router.navigate({ to: "/close-kombat", replace: true });
    }
  }, [role, realRole, pathname, router]);

  const navItems: NavItem[] = (() => {
    // Signed in but role-less = the waiting room (Day 1 before an Owner
    // assigns a role). No tabs at all — the old fallthrough showed this
    // account the LEADERSHIP nav, which read as broken admin clutter.
    if (user && !role) return [];
    if (role === "sales_rep") {
      return [{ to: "/close-kombat", label: "Close Kombat", icon: Swords }];
    }
    if (role === "canvasser") {
      // Chronological day order (2026-08-14): run → territory → Mission
      // (Plan/Log/Stats tabs) → leaders → wrap. Exactly 5 items, so the
      // bottom tab bar and swipe nav cover every canvass screen. Mission
      // deliberately carries NO search — activeOptions then matches on
      // pathname only, keeping the item lit while the inner tabs rewrite
      // ?tab=.
      return [
        { to: "/field", label: "Active Run", icon: Zap },
        { to: "/my-territory", label: "Territory", icon: MapPin },
        { to: "/dashboard", label: "Mission", icon: Target },
        { to: "/leaderboard", label: "Leaders", icon: Trophy },
        { to: "/daily-wrap", label: "Wrap", icon: Sparkles },
      ];
    }
    // Leadership: owner, captain, office_staff (manager suite). Close Kombat
    // only for roles its route guard admits — captains are excluded, so
    // don't show them a nav item that silently bounces.
    return [
      { to: "/dashboard", search: { tab: "dispatch" }, label: "Command", icon: LayoutDashboard },
      { to: "/my-territory", label: "Territory", icon: MapPin },
      { to: "/dashboard", search: { tab: "dispatch" }, label: "Fleet Dispatch", icon: Truck },
      { to: "/dashboard", search: { tab: "payroll" }, label: "Payroll", icon: DollarSign },
      { to: "/confirmation-desk", label: "Desk", icon: PhoneCall },
      ...(role && CLOSE_KOMBAT_ROLES.includes(role)
        ? [{ to: "/close-kombat", label: "Close Kombat", icon: Swords } as NavItem]
        : []),
      { to: "/daily-wrap", label: "Wrap", icon: Sparkles },
    ];
  })();


  async function signOut() {
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }

  // Field-mode gesture nav: canvassers swipe between their bottom-bar tabs
  // (map pans and h-scrollers are guarded inside the hook). Other roles keep
  // tap-only nav — their screens are dense with horizontal scroll areas.
  useSwipeNav(
    navItems.slice(0, 5).map((i) => ({ to: i.to, search: i.search })),
    role === "canvasser",
  );

  // min-h-dvh (not -screen): iOS Safari's collapsing toolbar makes 100vh
  // overshoot the visible area. px-safe keeps content off the notch in
  // landscape. overflow-x-hidden is the shell's own backstop on top of
  // body's overflow-x: clip — intended sideways scrolling happens only
  // inside explicit overflow-x-auto wrappers.
  return (
    <div className="min-h-dvh w-full max-w-full overflow-x-hidden flex flex-col bg-background px-safe">
      {/* Owner-only tool (owner decision 2026-08-12): View As never renders
          for captains, Admins, canvassers, or sales reps — and useAuth
          ignores the stored override for them too. */}
      {user && canUseViewAs(realRole) && (
        <div className="border-b border-[var(--neon-magenta)]/30 bg-background text-xs">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 py-1 sm:py-2 flex items-center gap-2 overflow-x-auto scrollbar-hide whitespace-nowrap">
            <FlaskConical className="w-3.5 h-3.5 text-[var(--neon-magenta)] shrink-0" />
            <span className="font-display uppercase tracking-widest text-[10px] text-[var(--neon-magenta)] shrink-0">
              View As
            </span>

            <select
              value={role ?? ""}
              onChange={(e) => {
                const v = e.target.value as AppRole;
                setDevRoleOverride(v === realRole ? null : v);
              }}
              className="bg-surface border border-border rounded px-2 py-1.5 min-h-11 md:min-h-9 text-base md:text-xs font-medium focus:outline-none focus:ring-1 focus:ring-[var(--neon-magenta)]"
            >
              <option value="owner">Owner</option>
              <option value="captain">Captain</option>
              <option value="canvasser">Canvasser</option>
              <option value="sales_rep">Sales Rep</option>
              <option value="office_staff">Manager</option>
            </select>
            {isOverridden && (
              <button
                onClick={() => setDevRoleOverride(null)}
                className="ml-auto min-h-11 md:min-h-9 px-2 rounded border border-[var(--neon-magenta)]/40 text-[10px] uppercase tracking-widest text-[var(--neon-magenta)]"
              >
                Reset to {realRole}
              </button>
            )}
          </div>
        </div>
      )}
      {/* pt-safe: in the installed (standalone) PWA the sticky header owns
          the status-bar strip; zero everywhere else. */}
      <header className="border-b border-border bg-background/95 backdrop-blur sticky top-0 z-20 pt-safe">
        {/* Mobile header: centered logo only. Side slots are 44px twins so
            the wordmark stays optically centered. */}
        <div className="md:hidden flex items-center justify-between px-4 py-2">
          <div className="w-11" />
          <Link
            to="/dashboard"
            search={{ tab: "dispatch" }}
            aria-label="Turf Invaders home"
            className="flex items-center justify-center min-h-11"
          >
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
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
              aria-label="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-11" />
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
                className="flex items-center gap-2 px-3 py-2 min-h-11 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                activeProps={{
                  className:
                    "flex items-center gap-2 px-3 py-2 min-h-11 rounded-md text-sm text-primary bg-surface-elevated ring-1 ring-primary/40",
                }}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <Link to="/dashboard" search={{ tab: "dispatch" }} className="flex items-center justify-center shrink-0" aria-label="Turf Invaders home">
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
                  className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                  aria-label="Sign out"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>
        {/* Score strip rides the sticky header — a canvasser mid-street never
            hunts for their number. Other roles render nothing here. */}
        {user && role === "canvasser" && <CanvasserHUD userId={user.id} />}
      </header>
      <main className="flex-1 max-w-7xl w-full min-w-0 mx-auto px-4 sm:px-6 py-4 md:py-8 pb-28 md:pb-8">{children}</main>

      {/* Mobile bottom tab bar — hidden entirely for role-less accounts
          (waiting room) instead of rendering an empty strip. */}
      {user && navItems.length > 0 && (
        <nav
          aria-label="Primary"
          className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur pb-safe px-safe"
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
