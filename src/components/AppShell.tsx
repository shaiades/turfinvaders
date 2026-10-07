import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  useAuth,
  setDevRoleOverride,
  setDevNameOverride,
  setDevCanvasserOverride,
  DEV_NAME_STORAGE_KEY,
  DEV_CANVASSER_STORAGE_KEY,
  type AppRole,
  type CanvasserPick,
} from "@/hooks/useAuth";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { useTheme } from "@/hooks/useTheme";
import { usePendingDojoCount } from "@/hooks/usePendingDojoCount";
import { usePendingProofCount } from "@/hooks/usePendingProofCount";
import { usePendingRespawnCount } from "@/hooks/usePendingRespawnCount";
import { AccessRevokedScreen, useLiveAccessRevoked } from "@/components/AccessRevokedScreen";
import { CanvasserHUD } from "@/components/CanvasserHUD";
import { CrewBeacon } from "@/components/CrewBeacon";
import { LeadConfirmedCelebration } from "@/components/LeadConfirmedCelebration";
import { AppMenu } from "@/components/AppMenu";
import { BackgroundMusic, MusicToggle } from "@/components/BackgroundMusic";
import { ProfilePhotoGate } from "@/components/profile-photo/ProfilePhotoGate";
import { PhotoNeededBanner } from "@/components/profile-photo/PhotoNeededBanner";
import { CanvasserTutorial, startCanvasserTutorial } from "@/components/tutorial/CanvasserTutorial";
import { WelcomeAnimation, isWelcomeAnimationForced } from "@/components/WelcomeAnimation";
import { CloseKombatIntro, isCloseKombatIntroForced } from "@/components/CloseKombatIntro";
import { EodRecapFx, isEodRecapForced } from "@/components/EodRecapFx";
import { useArcadeFlags } from "@/hooks/useArcadeFlags";
import { StreetFeed } from "@/components/StreetFeed";
import { BountyBanner } from "@/components/BountyBanner";
import { EodWrapGate, isEodWrapForced } from "@/components/EodWrapGate";
import {
  PurposeReminderCard,
  isPurposeReminderForced,
} from "@/components/purpose/PurposeReminderCard";
import { WeeklyPlanPopup, isWeeklyPlanPopupForced } from "@/components/WeeklyPlanPopup";
import { RespawnPopup, isRespawnPopupForced } from "@/components/RespawnPopup";
import { usePurposeConfig, readCachedPurposeEnabled } from "@/hooks/usePurposeConfig";
import {
  CLOSE_KOMBAT_ROLES,
  ROLE_LABEL,
  canUseViewAs,
  isManagerRole,
  privilegeRole,
  requiresProfilePhoto,
} from "@/lib/roles";
import { useMyPhotoStatus } from "@/hooks/useMyPhotoStatus";
import {
  LogOut,
  LayoutDashboard,
  MapPin,
  FlaskConical,
  DollarSign,
  FileSpreadsheet,
  Zap,
  Trophy,
  Target,
  PhoneCall,
  Sparkles,
  Swords,
  CalendarDays,
  GraduationCap,
  CircleHelp,
  Compass,
  Menu,
  Sun,
  Moon,
} from "lucide-react";
const turfInvadersWordmark = { url: "/turf-invaders-wordmark.png" };

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  search?: Record<string, string>;
  /** Small count pill on the item (e.g. Dojo submissions waiting on Desk). */
  badge?: number;
};

/** Small red dot flagging an unfinished profile photo on the help/menu chrome. */
function PhotoBadgeDot() {
  return (
    <span
      aria-label="Add your photo"
      className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-destructive ring-2 ring-background"
    />
  );
}

/** Count pill riding a nav icon. */
function NavBadge({ count }: { count?: number }) {
  if (!count) return null;
  return (
    <span
      aria-label={`${count} waiting`}
      className="absolute -top-1.5 -right-2 min-w-4 h-4 px-1 rounded-full text-background text-[9px] font-display leading-4 text-center"
      style={{ background: "var(--neon)" }}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

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
  // A canvasser who deep-links into My Purpose must SEE the spec's "coming
  // later" message — this guard fires before the route could render it, so
  // the path has to be allowed through; the route shows the message.
  "/my-purpose",
];

// Sales reps (closers) get two screens: Close Kombat (owner decision
// 2026-07-29) and My Purpose (owner decision 2026-09-23). /my-purpose stays
// on this list UNCONDITIONALLY — gating it on the launch flag here would
// race the flag query on a deep link and bounce a legitimate rep; the route
// itself redirects pre-launch reps.
const SALES_REP_ALLOWED = ["/close-kombat", "/my-purpose"];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, role, realRole, displayName, realDisplayName, accessRevoked } = useAuth();
  // §7 praise-public/coach-private: the Doughnut Zone stays on captain/manager
  // views; field roles only see it when the owner flips the flag off.
  const arcadeFlags = useArcadeFlags();
  const recapAct2Allowed =
    !arcadeFlags.coachPrivate || isManagerRole(realRole) || realRole === "captain";
  const { theme, toggleTheme } = useTheme();
  // Dojo submissions awaiting review — 0 for everyone outside the Admin tier.
  const pendingDojo = usePendingDojoCount();
  const pendingProofs = usePendingProofCount();
  // Shift-off requests awaiting a decision — 0 outside the Admin tier.
  const pendingRespawn = usePendingRespawnCount();
  // My Purpose launch flag — only reps (and owners, incl. View-As previews)
  // pay this query. The localStorage warm cache keeps a launched rep's
  // 2-item bottom bar from popping in on every cold load; pre-launch the
  // cached false means zero layout change.
  const purposeConfig = usePurposeConfig(
    !!user && (role === "sales_rep" || canUseViewAs(realRole)),
  );
  const purposeEnabled =
    canUseViewAs(realRole) || // owners always see it — they're the test crew
    (purposeConfig.data != null
      ? purposeConfig.data.sales_rep_feature_enabled === true
      : readCachedPurposeEnabled());
  // Removed players lose the app in-session, not just at next login: the DB
  // trigger (20260916100000) bans their auth account, and this live watch
  // swaps the shell for the lockout screen the moment a manager archives
  // them — or lifts it on reactivate. Early return lives just before the
  // shell's JSX so every hook above it still runs unconditionally.
  const revoked = useLiveAccessRevoked(user?.id ?? null, accessRevoked);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // First-sign-in arcade intro: while it's checking/playing, hold the page
  // tour back so the two first-open moments can't stack.
  const [introActive, setIntroActive] = useState(false);
  const [purposeReminderActive, setPurposeReminderActive] = useState(false);
  // Weekly Action Plan popup: active while UNSETTLED (not just showing), so
  // the purpose reminder and the page tour can't pop underneath it during
  // its checking/ready races (the PurposeReminderCard stacking lesson).
  const [planPopupActive, setPlanPopupActive] = useState(false);
  // End-of-day recap cutscene: same hold for the tour. Play order on a
  // morning open that owes both: intro → EOD recap → page tour.
  const [eodActive, setEodActive] = useState(false);
  // Personal Daily Wrap auto-play (9 PM PT, canvassers/captains): held behind
  // the intro AND the team EOD recap so the two cutscenes never stack.
  const [wrapActive, setWrapActive] = useState(false);
  // Respawn reminder (Fri 6 PM → Sun 12 PM): held behind intro + plan +
  // purpose; active while UNSETTLED so the page tour waits for it too.
  const [respawnPopupActive, setRespawnPopupActive] = useState(false);
  // Blocking profile-photo gate (owner 2026-10-06): the TOP-priority first-open
  // moment. While it owns the screen (or is still deciding for a gated player),
  // every cutscene below is held back so none burns its once-ever flag beneath
  // it — the photo step comes first, then the intro, EOD recap, etc.
  const [photoGateActive, setPhotoGateActive] = useState(false);
  // Compare against the COLLAPSED real role: a confirmer's `role` is always
  // "canvasser" (privilegeRole in useAuth) and must not read as a View As
  // override.
  const isOverridden = role !== privilegeRole(realRole) && realRole !== null;
  // Red dot on the personal chrome (help/menu) when this player still owes a
  // photo — a quiet second nudge that mainly shows once an admin has enabled
  // "Remind me later" (otherwise the blocking gate is up instead). Gated on the
  // REAL role so a View-As preview never paints it.
  const photoStatus = useMyPhotoStatus(user?.id, realDisplayName);
  const needsPhotoBadge =
    !!user && requiresProfilePhoto(realRole) && !photoStatus.loading && !photoStatus.hasPhoto;
  // Chrome diet (owner, 2026-10-01): with no override active the full
  // View-As bar is dead weight above every page — collapse it to a slim
  // chip and expand on tap. An active override always shows the full bar.
  const [viewAsOpen, setViewAsOpen] = useState(false);

  // View As rep picker (owner request 2026-09-13): inside a Sales Rep
  // preview, choose WHICH rep — the name is what Close Kombat's matcher
  // keys on, so this is the whole impersonation. Display-only: data stays
  // the owner's, and useAuth ignores the key outside a sales_rep preview.
  const [nameOverride, setNameOverride] = useState<string | null>(() =>
    typeof window === "undefined" ? null : window.localStorage.getItem(DEV_NAME_STORAGE_KEY),
  );
  const applyNameOverride = (v: string | null) => {
    setDevNameOverride(v);
    setNameOverride(v?.trim() || null);
  };
  // View As canvasser picker (owner request 2026-10-06): inside a Canvasser
  // preview, choose WHICH canvasser — the Close Kombat rep picker's twin.
  // Canvasser surfaces key on the profile ID, so the pick stores id + name;
  // useAuth turns it into displayName + previewCanvasserId (reads only —
  // write surfaces hide or lock while previewing someone else).
  const [canvasserPick, setCanvasserPick] = useState<CanvasserPick | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(DEV_CANVASSER_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as CanvasserPick) : null;
    } catch {
      return null;
    }
  });
  const applyCanvasserPick = (v: CanvasserPick | null) => {
    setDevCanvasserOverride(v);
    setCanvasserPick(v);
  };
  const showCanvasserPicker = !!user && canUseViewAs(realRole) && role === "canvasser";
  const canvassersQuery = useQuery({
    queryKey: ["view-as-canvassers"],
    enabled: showCanvasserPicker,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CanvasserPick[]> => {
      // Confirmers live the canvasser app (privilegeRole collapses them), so
      // they're previewable too.
      const { data: roleRows, error: rolesErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["canvasser", "confirmer"]);
      if (rolesErr) throw rolesErr;
      const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
      if (ids.length === 0) return [];
      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (profErr) throw profErr;
      return (profs ?? [])
        .flatMap((p) => {
          const n = (p.display_name ?? "").trim();
          return n ? [{ id: p.id, name: n }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  const showRepPicker = !!user && canUseViewAs(realRole) && role === "sales_rep";
  const repNamesQuery = useQuery({
    queryKey: ["view-as-rep-names"],
    enabled: showRepPicker,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<string[]> => {
      const { data: roleRows, error: rolesErr } = await supabase
        .from("user_roles")
        .select("user_id")
        .eq("role", "sales_rep");
      if (rolesErr) throw rolesErr;
      const ids = [...new Set((roleRows ?? []).map((r) => r.user_id))];
      if (ids.length === 0) return [];
      const { data: profs, error: profErr } = await supabase
        .from("profiles")
        .select("display_name")
        .in("id", ids);
      if (profErr) throw profErr;
      const names = new Set<string>();
      for (const p of profs ?? []) {
        const n = (p.display_name ?? "").trim();
        if (n) names.add(n);
      }
      return [...names].sort((a, b) => a.localeCompare(b));
    },
  });

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
      return [
        { to: "/close-kombat", label: "Close Kombat", icon: Swords },
        // The Weekly Action Plan's always-available reopen (owner spec
        // 2026-10-01 §1): one obvious tap from anywhere, including
        // /my-purpose — same two-items-one-path pattern as the bookkeeper
        // Reports/Payroll pair.
        { to: "/close-kombat", search: { tab: "plan" }, label: "Plan", icon: CalendarDays },
        // My Purpose appears once the owners flip the launch flag (or in an
        // owner's View-As preview). Two items also switches on the mobile
        // bottom bar for reps — that's intentional: the workshop must be one
        // obvious tap from anywhere (owner ask 2026-09-23).
        ...(purposeEnabled ? [{ to: "/my-purpose", label: "My Purpose", icon: Compass }] : []),
      ];
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
    if (role === "bookkeeper") {
      // Mary's two-tab app: the Reports console (exports) and the read-only
      // Payroll ledger view inside it. Explicit branch — the leadership
      // fallthrough below would hand an unknown role the admin nav.
      return [
        { to: "/reports", search: { tab: "exports" }, label: "Reports", icon: FileSpreadsheet },
        { to: "/reports", search: { tab: "payroll" }, label: "Payroll", icon: DollarSign },
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
      // Badge = Dojo submissions + Kombat Month proofs waiting for review —
      // the in-app companion to the notify-dojo push, so work waiting is
      // visible even with push alerts off on this device.
      {
        to: "/confirmation-desk",
        label: "Desk",
        icon: PhoneCall,
        badge: pendingDojo + pendingProofs,
      },
      // Badge = shift-off (Respawn) requests waiting on Tyler/Shai/Jorge.
      ...(role && CLOSE_KOMBAT_ROLES.includes(role)
        ? [
            {
              to: "/close-kombat",
              label: "Close Kombat",
              icon: Swords,
              badge: pendingRespawn,
            } as NavItem,
          ]
        : []),
    ];
  })();

  // The hamburger menu is the management tier's overflow: the office pages
  // for Owners/Admins (Manage Players carries the invite flow), plus the
  // standalone Invite a Player for Captains, who can't open /users.
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

  // The lockout replaces the WHOLE shell (nav, HUD, CrewBeacon, children):
  // a removed player's session must not keep broadcasting GPS or rendering
  // team data while their token runs out its last minutes.
  if (user && revoked) {
    return <AccessRevokedScreen onSignOut={signOut} />;
  }

  // min-h-dvh (not -screen): iOS Safari's collapsing toolbar makes 100vh
  // overshoot the visible area. px-safe keeps content off the notch in
  // landscape. overflow-x-hidden is the shell's own backstop on top of
  // body's overflow-x: clip — intended sideways scrolling happens only
  // inside explicit overflow-x-auto wrappers.
  return (
    <div className="min-h-dvh w-full max-w-full overflow-x-hidden flex flex-col bg-background px-safe">
      {/* pt-safe: the sticky header owns the status-bar strip in the
          installed (standalone) PWA; zero everywhere else. It also covers
          the owner-only View As strip below, which lives as the header's
          top row — previously it rendered ABOVE the header with no inset,
          so on an iPhone it drew up under the status bar / Dynamic Island
          and was untappable. Keeping it inside the one sticky, inset-padded
          header makes the chip clear the notch and stay reachable. */}
      <header className="border-b border-border bg-background/95 backdrop-blur sticky top-0 z-20 pt-safe">
        {/* Owner-only tool (owner decision 2026-08-12): View As never renders
            for captains, Admins, canvassers, or sales reps — and useAuth
            ignores the stored override for them too. */}
        {user && canUseViewAs(realRole) && !isOverridden && !viewAsOpen && (
          <div className="border-b border-[var(--neon-magenta)]/20">
            <div className="max-w-7xl mx-auto px-3 sm:px-6">
              <button
                type="button"
                onClick={() => setViewAsOpen(true)}
                title="Preview the app as another role"
                className="inline-flex min-h-11 md:min-h-8 items-center gap-1.5 pr-2 text-[11px] md:text-[10px] font-display uppercase tracking-widest text-[var(--neon-magenta)]/70 hover:text-[var(--neon-magenta)] transition-colors"
              >
                <FlaskConical className="h-3.5 w-3.5" /> View As
              </button>
            </div>
          </div>
        )}
        {user && canUseViewAs(realRole) && (isOverridden || viewAsOpen) && (
          <div className="border-b border-[var(--neon-magenta)]/30 text-xs">
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
                  if (v !== "sales_rep") applyNameOverride(null);
                  if (v !== "canvasser") applyCanvasserPick(null);
                }}
                className="bg-surface border border-border rounded px-2 py-1.5 min-h-11 md:min-h-9 text-base md:text-xs font-medium focus:outline-none focus:ring-1 focus:ring-[var(--neon-magenta)]"
              >
                <option value="owner">Owner</option>
                <option value="captain">Captain</option>
                <option value="canvasser">Canvasser</option>
                <option value="sales_rep">Sales Rep</option>
                <option value="office_staff">Manager</option>
              </select>
              {showCanvasserPicker && (
                <select
                  value={canvasserPick?.id ?? ""}
                  onChange={(e) => {
                    const picked = (canvassersQuery.data ?? []).find(
                      (c) => c.id === e.target.value,
                    );
                    applyCanvasserPick(picked ?? null);
                  }}
                  aria-label="Preview as a specific canvasser"
                  className="bg-surface border border-border rounded px-2 py-1.5 min-h-11 md:min-h-9 text-base md:text-xs font-medium focus:outline-none focus:ring-1 focus:ring-[var(--neon-magenta)]"
                >
                  <option value="">Yourself</option>
                  {/* Keep a stale/still-loading pick visible so the select
                      never silently snaps back to "Yourself". */}
                  {canvasserPick &&
                    !(canvassersQuery.data ?? []).some((c) => c.id === canvasserPick.id) && (
                      <option value={canvasserPick.id}>{canvasserPick.name}</option>
                    )}
                  {(canvassersQuery.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
              {showRepPicker && (
                <select
                  value={nameOverride ?? ""}
                  onChange={(e) => applyNameOverride(e.target.value || null)}
                  aria-label="Preview as a specific rep"
                  className="bg-surface border border-border rounded px-2 py-1.5 min-h-11 md:min-h-9 text-base md:text-xs font-medium focus:outline-none focus:ring-1 focus:ring-[var(--neon-magenta)]"
                >
                  <option value="">Yourself</option>
                  {/* Keep a stale/still-loading selection visible so the select
                      never silently snaps back to "Yourself". */}
                  {nameOverride && !(repNamesQuery.data ?? []).includes(nameOverride) && (
                    <option value={nameOverride}>{nameOverride}</option>
                  )}
                  {(repNamesQuery.data ?? []).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
              {isOverridden && (
                <button
                  onClick={() => {
                    setDevRoleOverride(null);
                    applyNameOverride(null);
                    applyCanvasserPick(null);
                  }}
                  className="ml-auto min-h-11 md:min-h-9 px-3 rounded border border-[var(--neon-magenta)]/40 text-[10px] uppercase tracking-widest text-[var(--neon-magenta)]"
                >
                  Reset to {realRole}
                </button>
              )}
              {!isOverridden && (
                <button
                  onClick={() => setViewAsOpen(false)}
                  className="ml-auto min-h-11 md:min-h-9 px-3 text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  Hide
                </button>
              )}
            </div>
          </div>
        )}
        {/* Mobile header: centered logo only. Side slots are equal-width
            twins so the wordmark stays optically centered — signed-out is
            44px each, signed-in is 88px each (theme toggle joins the left
            slot's help/hamburger/spacer; a matching spacer joins sign-out
            on the right). Canvassers get the tutorial replay in the left
            slot, the management tier gets the hamburger, everyone else
            keeps the spacer. */}
        <div className="md:hidden flex items-center justify-between px-4 py-2">
          {user ? (
            <div className="flex items-center">
              <button
                onClick={toggleTheme}
                className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
              </button>
              {role === "canvasser" || role === "sales_rep" ? (
                <button
                  onClick={startCanvasserTutorial}
                  data-tour="help"
                  className="relative min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                  aria-label="Replay the app tutorial"
                >
                  <CircleHelp className="w-5 h-5" />
                  {needsPhotoBadge && <PhotoBadgeDot />}
                </button>
              ) : hasMenu ? (
                <button
                  onClick={() => setMenuOpen(true)}
                  className="relative min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                  aria-label="Open menu"
                >
                  <Menu className="w-5 h-5" />
                  {needsPhotoBadge && <PhotoBadgeDot />}
                </button>
              ) : (
                <div className="w-11" />
              )}
            </div>
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
            <div className="flex items-center">
              {/* Music mute/unmute fills the old centering spacer; the
                  component renders the 44px spacer itself until the track
                  file exists, so the wordmark never shifts. */}
              <MusicToggle spacer />
              <button
                onClick={signOut}
                className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                aria-label="Sign out"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
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
                <span className="relative inline-flex">
                  <item.icon className="w-4 h-4" />
                  <NavBadge count={item.badge} />
                </span>
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
                {(role === "canvasser" || role === "captain" || role === "sales_rep") && (
                  <button
                    onClick={startCanvasserTutorial}
                    data-tour="help"
                    className="relative min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                    aria-label="Replay the app tutorial"
                  >
                    <CircleHelp className="w-5 h-5" />
                    {needsPhotoBadge && <PhotoBadgeDot />}
                  </button>
                )}
                {hasMenu && (
                  <button
                    onClick={() => setMenuOpen(true)}
                    className="relative min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                    aria-label="Open menu"
                  >
                    <Menu className="w-5 h-5" />
                    {needsPhotoBadge && <PhotoBadgeDot />}
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
                <MusicToggle />
                <button
                  onClick={toggleTheme}
                  className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground"
                  aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
                >
                  {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                </button>
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
      {/* §7 Street Feed — the field's live big-moments ticker (field + leadership,
          not sales reps who live in Close Kombat). */}
      {user && realRole !== null && privilegeRole(realRole) !== "sales_rep" && <StreetFeed />}
      {user && realRole !== null && privilegeRole(realRole) !== "sales_rep" && <BountyBanner />}
      {/* App-wide crew-live publisher — self-gated (field tiers, real role,
          GPS already granted). Renders nothing. */}
      <CrewBeacon />
      {/* Background music engine — loops Radio Los Santos for the whole
          session, signed-in only. Renders nothing; the header MusicToggle
          buttons mute/unmute it. Self-hides until the MP3 exists at
          public/audio/radio-los-santos.mp3. */}
      {user && <BackgroundMusic />}
      {/* Lead-confirmed celebration — realtime INSERT on lead_events, gated to
          canvasser+captain. Renders nothing; fires confetti + toast + beep on
          the payoff moment (desk or Monday confirms). Demo: ?lead_confirm_demo=1 */}
      {user && (role === "canvasser" || role === "captain") && (
        <LeadConfirmedCelebration userId={user.id} />
      )}
      <main
        className={`flex-1 max-w-7xl w-full min-w-0 mx-auto px-4 sm:px-6 py-4 md:py-8 md:pb-8 ${
          user && navItems.length > 1 ? "pb-28" : "pb-8"
        }`}
      >
        {/* Second nudge: a home banner for anyone still missing a photo (only
            reachable when an admin has enabled "Remind me later"). */}
        {user && <PhotoNeededBanner />}
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
                  <span className="relative inline-flex">
                    <item.icon className="w-5 h-5" />
                    <NavBadge count={item.badge} />
                  </span>
                  <span className="truncate max-w-full px-1">{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {/* Management hamburger drawer (captains' Invite a Player lives behind it). */}
      {user && hasMenu && <AppMenu open={menuOpen} onOpenChange={setMenuOpen} />}

      {/* First-sign-in arcade intro — every role, once per account. Sales
          reps' whole app is Close Kombat, so they open on the door-kick
          cutscene instead of the van arrival (owner ask 2026-09-10);
          `?ck_anim=1` previews the kick from any account, `?welcome_anim=1`
          still previews the van from non-rep accounts. */}
      {user &&
        // The blocking photo gate comes first: hold the once-ever intro until
        // the gate has stepped aside, so it never plays (and burns its flag)
        // underneath the full-screen photo step.
        !photoGateActive &&
        // Wait for a role: a brand-new account used to burn its once-ever
        // intro in the role-less waiting room, then get hard-reloaded into
        // the real app with the flag already spent. Now the intro plays on
        // the first load of the app they'll actually use. Forced previews
        // stay available to role-less accounts.
        (realRole !== null || isCloseKombatIntroForced() || isWelcomeAnimationForced()) &&
        // Gate on the REAL role: an owner previewing View As → Sales Rep used
        // to trigger a non-forced playback that burned the owner's own
        // ti_ck_intro flag (rep audit). Previews go through ?ck_anim=1,
        // which never writes flags.
        (privilegeRole(realRole) === "sales_rep" || isCloseKombatIntroForced() ? (
          <CloseKombatIntro userId={user.id} onActiveChange={setIntroActive} />
        ) : (
          <WelcomeAnimation userId={user.id} onActiveChange={setIntroActive} />
        ))}

      {/* End-of-day recap — every non-rep role, once per COMPLETED report day
          (the 6 PM PT lock; owner ask 2026-09-22): the day's top canvassers,
          then the doughnut zone. Gated on the REAL role like the intro;
          `?eod_demo=1` previews with canned names from any account and never
          stamps. `heldBack` sequences it after the morning intro. */}
      {user &&
        (isEodRecapForced() || (realRole !== null && privilegeRole(realRole) !== "sales_rep")) && (
          <EodRecapFx
            userId={user.id}
            heldBack={introActive || photoGateActive}
            onActiveChange={setEodActive}
            act2Allowed={recapAct2Allowed}
          />
        )}

      {/* Personal Daily Wrap cinematic — canvassers & captains, once per LA day
          on the first open at/after 9 PM PT. Sequenced AFTER the morning intro
          and the team EOD recap via heldBack; gated on the REAL role so a
          View-As preview can't burn the stamp. `?eod_wrap=1` previews from any
          account without stamping; the Wrap tab's Replay re-runs it any time. */}
      {user &&
        (isEodWrapForced() ||
          (realRole !== null &&
            (privilegeRole(realRole) === "canvasser" ||
              privilegeRole(realRole) === "captain"))) && (
          <EodWrapGate
            userId={user.id}
            heldBack={introActive || eodActive || photoGateActive}
            onActiveChange={setWrapActive}
          />
        )}

      {/* Blocking profile-photo gate (owner 2026-10-06) — the full-screen
          "Snap your fighter photo" step. Self-gated on the REAL role + photo
          status (canvassers only, confirmers collapse in; everyone else is
          never asked). It owns the screen until a photo is saved — no skip by
          default — and reports `onActiveChange` so the cutscenes above stay
          held behind it. Replaces the old skippable FighterPhotoPrompt.
          Previews: ?photo_gate=1 / =error / =unlocked. */}
      {user && <ProfilePhotoGate onActiveChange={setPhotoGateActive} />}

      {/* Weekly Action Plan popup — reps only, once per PLAN week (Sunday
          shows the upcoming week). Sequenced after the door-kick intro via
          heldBack; gated on the REAL role so a View-As preview can't burn
          the owner's week stamp (`?plan_pop=1` previews without stamping,
          same contract as the other overlays). */}
      {user && (isWeeklyPlanPopupForced() || privilegeRole(realRole) === "sales_rep") && (
        <WeeklyPlanPopup
          userId={user.id}
          heldBack={introActive || photoGateActive}
          onActiveChange={setPlanPopupActive}
        />
      )}

      {/* Daily "remember your why" — reps only, once per LA day, and ONLY
          after their Purpose Profile is submitted (the card itself checks
          and stays silent otherwise). Sequenced after the door-kick intro
          AND the weekly plan popup via heldBack; gated on the REAL role so a
          View-As preview can't burn the owner's daily flag
          (`?purpose_reminder=1` previews without stamping, same contract as
          the other overlays). */}
      {user && (isPurposeReminderForced() || privilegeRole(realRole) === "sales_rep") && (
        <PurposeReminderCard
          userId={user.id}
          heldBack={introActive || planPopupActive || photoGateActive}
          onActiveChange={setPurposeReminderActive}
        />
      )}

      {/* Respawn reminder — reps only, Fri 6 PM → Sun 12 PM PT, once per coming
          week. Held behind the intro, weekly plan, and purpose reminder so the
          first-open overlays never stack; gated on the REAL role so a View-As
          preview can't burn the owner's week stamp (`?respawn_pop=1` previews
          without stamping). */}
      {user && (isRespawnPopupForced() || privilegeRole(realRole) === "sales_rep") && (
        <RespawnPopup
          userId={user.id}
          heldBack={introActive || planPopupActive || purposeReminderActive || photoGateActive}
          onActiveChange={setRespawnPopupActive}
        />
      )}

      {/* Per-page discovery tips: each screen's mini-tour auto-pops the first
          time this account opens it; the header "?" replays the current
          screen's tips. Canvasser tier + captains + sales reps (the kombat
          tour, rep audit R-7) — deferred until the intro animation has
          finished. Gated on the REAL role: a View-As preview used to write
          the owner's own ti_tour flags (the same bug class the intro
          gating fixed). */}
      {user &&
        (() => {
          const tourRole = privilegeRole(realRole);
          return (
            (tourRole === "canvasser" || tourRole === "captain" || tourRole === "sales_rep") &&
            !photoGateActive &&
            !introActive &&
            !eodActive &&
            !wrapActive &&
            !planPopupActive &&
            !purposeReminderActive &&
            !respawnPopupActive && (
              <CanvasserTutorial
                userId={user.id}
                missionRoute={tourRole === "captain" ? "/mission" : "/dashboard"}
              />
            )
          );
        })()}
    </div>
  );
}
