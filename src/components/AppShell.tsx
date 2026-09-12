import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth, setDevRoleOverride, type AppRole } from "@/hooks/useAuth";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { CanvasserHUD } from "@/components/CanvasserHUD";
import { AppMenu } from "@/components/AppMenu";
import { CanvasserTutorial, startCanvasserTutorial } from "@/components/tutorial/CanvasserTutorial";
import { WelcomeAnimation } from "@/components/WelcomeAnimation";
import { CloseKombatIntro, isCloseKombatIntroForced } from "@/components/CloseKombatIntro";
import { CLOSE_KOMBAT_ROLES, ROLE_LABEL, canUseViewAs, privilegeRole } from "@/lib/roles";
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
  Swords,
  GraduationCap,
  CircleHelp,
  Menu,
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
// /log and /my-territory MUST stay here even though canvassers get
// redirected off them — the guard below fires on pathname before the routes'
// own <Navigate> runs, so dropping either would bounce old bookmarks to
// /field the hard way (or loop). /playbook redirects in beforeLoad (throws
// before the location commits), so it can stay off this list.
const CANVASSER_ALLOWED = [
  "/field",
  "/my-territory",
  "/dashboard",
  // /mission is the captain split-out of the Mission surface; a canvasser who
  // lands here (stray link/bookmark) is redirected to /dashboard by the route
  // itself, so keep it allowed rather than hard-bouncing them to /field.
  "/mission",
  "/log",
  "/learn",
  "/leaderboard",
  "/daily-wrap",
];

// Sales reps (closers) get exactly one screen: Close Kombat (owner decision
// 2026-07-29). Anything else → redirect there.
const SALES_REP_ALLOWED = ["/close-kombat"];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, realRole, displayName } = useAuth();
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // First-sign-in arcade intro: while it's checking/playing, hold the page
  // tour back so the two first-open moments can't stack.
  const [introActive, setIntroActive] = useState(false);
  // Compare against the COLLAPSED real role: a confirmer's `role` is always
  // "canvasser" (privilegeRole in useAuth) and must not read as a View As
  // override.
  const isOverridden = role !== privilegeRole(realRole) && realRole !== null;

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
      // Chronological day order, map merged (2026-09-08): Active Run now IS
      // the territory map + tallies, and Learn takes the freed slot (owner
      // decision). Exactly 5 items, so the bottom tab bar and swipe nav
      // cover every canvass screen. Mission deliberately carries NO search —
      // activeOptions then matches on pathname only, keeping the item lit
      // while the inner tabs rewrite ?tab=.
      return [
        { to: "/field", label: "Active Run", icon: Zap },
        { to: "/dashboard", label: "Mission", icon: Target },
        { to: "/learn", label: "Learn", icon: GraduationCap },
        { to: "/leaderboard", label: "Leaders", icon: Trophy },
        { to: "/daily-wrap", label: "Wrap", icon: Sparkles },
      ];
    }
    if (role === "captain") {
      // Captains knock doors too (owner request 2026-09-09), so they get the
      // FULL canvasser toolkit + their leadership privileges: Mission (/mission,
      // the personal clock/pay/Plan/Log/Stats surface a canvasser has on
      // /dashboard) plus Command (CaptainDashboard, the van overview). The two
      // live on separate routes so both stay lit and neither collides on
      // /dashboard's ?tab. No Payroll (CaptainDashboard has no ?tab views) and
      // no Desk (/confirmation-desk is Admin-tier and bounces). Territory IS
      // the Active Run canvass map + Turf Tools; Fleet Dispatch points at the
      // live board (row edits stay role-gated inside FleetDispatch). Six items
      // (the mobile bar widens to 6 for captains) — everything a canvasser
      // reaches, plus the two they don't. Each carries no search so
      // activeOptions matches on pathname alone (Mission precedent above),
      // keeping the item lit while inner ?tab= rewrites.
      // Short labels so all six fit the mobile bottom bar without truncating
      // (six 62px cells at 375px). "Turf" is the canonical word (go-live
      // decision); /leaderboard is the ranked LADDER for captains now
      // (owner call 2026-09-12) — van ops live on Command.
      return [
        { to: "/dashboard", label: "Command", icon: LayoutDashboard },
        { to: "/mission", label: "Mission", icon: Target },
        { to: "/my-territory", label: "Turf", icon: MapPin },
        { to: "/leaderboard", label: "Leaders", icon: Trophy },
        { to: "/learn", label: "Learn", icon: GraduationCap },
        { to: "/daily-wrap", label: "Wrap", icon: Sparkles },
      ];
    }
    // Leadership: owner + office_staff (Admin tier — captains returned above).
    // Slimmed to the daily-driver five (2026-09-11 owner ask: stop crowding
    // the bar) — the old duplicate "Fleet Dispatch" entry (identical
    // destination to Command) is gone, and Learn/Wrap moved into the
    // hamburger AppMenu with Manage Players and Invite. Five items also
    // means the mobile bottom bar (capped at 5) finally shows everything.
    // Close Kombat only for roles its route guard admits.
    return [
      { to: "/dashboard", search: { tab: "dispatch" }, label: "Command", icon: LayoutDashboard },
      { to: "/my-territory", label: "Territory", icon: MapPin },
      { to: "/dashboard", search: { tab: "payroll" }, label: "Payroll", icon: DollarSign },
      { to: "/confirmation-desk", label: "Desk", icon: PhoneCall },
      ...(role && CLOSE_KOMBAT_ROLES.includes(role)
        ? [{ to: "/close-kombat", label: "Close Kombat", icon: Swords } as NavItem]
        : []),
    ];
  })();

  // The hamburger menu is the management tier's overflow: Invite a Player
  // (Owners/Admins/Captains), plus the office pages for Owners/Admins.
  const hasMenu = role === "owner" || role === "office_staff" || role === "captain";
  const [menuOpen, setMenuOpen] = useState(false);

  // Mobile bottom bar caps at 5 for everyone except captains, who carry a 6th
  // (Mission joined their canvasser toolkit 2026-09-09) — all six are field
  // tools, so none should hide off the phone. Admins keep 5 (their overflow is
  // desktop-only clutter; they don't canvass from a phone).
  const bottomBarMax = role === "captain" ? 6 : 5;

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
            the wordmark stays optically centered. Canvassers get the tutorial
            replay in the left slot, the management tier gets the hamburger,
            everyone else keeps the spacer. */}
        <div className="md:hidden flex items-center justify-between px-4 py-2">
          {user && role === "canvasser" ? (
            <button
              onClick={startCanvasserTutorial}
              data-tour="help"
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
              aria-label="Replay the app tutorial"
            >
              <CircleHelp className="w-5 h-5" />
            </button>
          ) : user && hasMenu ? (
            <button
              onClick={() => setMenuOpen(true)}
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
              aria-label="Open menu"
            >
              <Menu className="w-5 h-5" />
            </button>
          ) : (
            <div className="w-11" />
          )}
          {/* Reps' home IS Close Kombat — the /dashboard link used to mount
              the full canvasser Mission for a flash frame before the cage
              bounced them back (rep audit R-13). */}
          <Link
            to={role === "sales_rep" ? "/close-kombat" : "/dashboard"}
            search={(role === "sales_rep" ? undefined : { tab: "dispatch" }) as never}
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
                data-tour={`nav${item.to.replaceAll("/", "-")}`}
                activeOptions={{ includeSearch: !!item.search, exact: !item.search }}
                className="flex items-center gap-2 px-2 py-2 min-h-11 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-surface-elevated transition-colors"
                activeProps={{
                  className:
                    "flex items-center gap-2 px-2 py-2 min-h-11 rounded-md text-sm text-primary bg-surface-elevated ring-1 ring-primary/40",
                }}
              >
                <item.icon className="w-4 h-4" />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <Link
            to={role === "sales_rep" ? "/close-kombat" : "/dashboard"}
            search={(role === "sales_rep" ? undefined : { tab: "dispatch" }) as never}
            className="flex items-center justify-center shrink-0"
            aria-label="Turf Invaders home"
          >
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
                {(role === "canvasser" || role === "captain") && (
                  <button
                    onClick={startCanvasserTutorial}
                    data-tour="help"
                    className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                    aria-label="Replay the app tutorial"
                  >
                    <CircleHelp className="w-5 h-5" />
                  </button>
                )}
                {hasMenu && (
                  <button
                    onClick={() => setMenuOpen(true)}
                    className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                    aria-label="Open menu"
                  >
                    <Menu className="w-5 h-5" />
                  </button>
                )}
                <div className="text-right">
                  {/* Human label, never the raw enum — "SALES_REP" with the
                      underscore was the first thing a closer read (R-13). */}
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">
                    {role ? ROLE_LABEL[role] : ""}
                  </div>
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
            hunts for their number. Captains get it too (audit 2026-09-12):
            they punch like canvassers, and the OFF CLOCK alarm matters most
            for the player-coach busy running a van. */}
        {user && (role === "canvasser" || role === "captain") && <CanvasserHUD userId={user.id} />}
      </header>
      <main
        className={`flex-1 max-w-7xl w-full min-w-0 mx-auto px-4 sm:px-6 py-4 md:py-8 md:pb-8 ${
          user && navItems.length > 1 ? "pb-28" : "pb-8"
        }`}
      >
        {children}
      </main>

      {/* Mobile bottom tab bar — hidden for role-less accounts (waiting
          room) AND for single-destination roles: a sales rep's one-cell
          permanently-active bar burned ~80px of phone height navigating to
          nowhere (rep audit R-13). */}
      {user && navItems.length > 1 && (
        <nav
          aria-label="Primary"
          className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-border bg-background/95 backdrop-blur pb-safe px-safe"
        >
          <ul
            className="grid"
            style={{
              gridTemplateColumns: `repeat(${Math.min(navItems.length, bottomBarMax)}, minmax(0, 1fr))`,
            }}
          >
            {navItems.slice(0, bottomBarMax).map((item) => (
              <li key={`bt-${item.to}-${item.label}`}>
                <Link
                  to={item.to}
                  search={item.search as never}
                  data-tour={`nav${item.to.replaceAll("/", "-")}`}
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

      {/* Management hamburger drawer + the Invite a Player flow behind it. */}
      {user && hasMenu && <AppMenu open={menuOpen} onOpenChange={setMenuOpen} />}

      {/* First-sign-in arcade intro — every role, once per account. Sales
          reps' whole app is Close Kombat, so they open on the door-kick
          cutscene instead of the van arrival (owner ask 2026-09-10);
          `?ck_anim=1` previews the kick from any account, `?welcome_anim=1`
          still previews the van from non-rep accounts. */}
      {user &&
        // Gate on the REAL role: an owner previewing View As → Sales Rep used
        // to trigger a non-forced playback that burned the owner's own
        // ti_ck_intro flag (rep audit). Previews go through ?ck_anim=1,
        // which never writes flags.
        (privilegeRole(realRole) === "sales_rep" || isCloseKombatIntroForced() ? (
          <CloseKombatIntro userId={user.id} onActiveChange={setIntroActive} />
        ) : (
          <WelcomeAnimation userId={user.id} onActiveChange={setIntroActive} />
        ))}

      {/* Per-page discovery tips: each screen's mini-tour auto-pops the first
          time this account opens it; the header "?" replays the current
          screen's tips. Canvassers only — and deferred until the intro
          animation has finished. */}
      {user && (role === "canvasser" || role === "captain") && !introActive && (
        <CanvasserTutorial userId={user.id} missionRoute={role === "captain" ? "/mission" : "/dashboard"} />
      )}
    </div>
  );
}
