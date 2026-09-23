import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { InvitePlayerSheet } from "@/components/InvitePlayerSheet";
import { startCanvasserTutorial } from "@/components/tutorial/CanvasserTutorial";
import { useAuth } from "@/hooks/useAuth";
import { ROLE_LABEL } from "@/lib/role-policy";
import { GraduationCap, Radar, Send, Sparkles, Users, CircleHelp, Compass, Telescope } from "lucide-react";

const itemCls =
  "w-full flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-3 min-h-12 text-left text-xs font-display uppercase tracking-widest text-foreground hover:border-neon/60 hover:text-neon transition-colors";

/** The management hamburger: everything a leader reaches occasionally lives
 *  here instead of crowding the top bar. Role-scoped — Owners/Admins get the
 *  office pages (Manage Players, Learn, Daily Wrap moved in from the old
 *  8-item bar), Captains get exactly the one action their tabs don't cover:
 *  Invite a Player. Canvassers and sales reps have no menu (their whole app
 *  is their tab bar). The invite action closes the drawer and opens the
 *  roster picker so the two bottom sheets never stack. */
export function AppMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { role, displayName } = useAuth();
  const [inviteOpen, setInviteOpen] = useState(false);
  const isAdminTier = role === "owner" || role === "office_staff";
  const isOwner = role === "owner";
  const canInvite = isAdminTier || role === "captain";

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle className="font-display uppercase tracking-widest text-neon">
              Menu
            </SheetTitle>
            <SheetDescription>
              {displayName}
              {role ? ` · ${ROLE_LABEL[role] ?? role}` : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 space-y-2 overflow-y-auto">
            {canInvite && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  setInviteOpen(true);
                }}
                className="w-full flex items-center gap-3 rounded-md border border-neon/50 bg-neon/10 px-4 py-3 min-h-12 text-left text-xs font-display uppercase tracking-widest text-neon hover:bg-neon/20 transition-colors"
              >
                <Send className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Invite a Player
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    Sign-in link — creates their login if they don't have one
                  </span>
                </span>
              </button>
            )}
            {/* All three leadership tiers (owner ask 2026-09-14: captains,
                managers, owner see everyone's live activity any time). */}
            <Link to="/crew-map" onClick={() => onOpenChange(false)} className={itemCls}>
              <Radar className="w-4 h-4 shrink-0" />
              <span className="flex-1">
                Crew Map
                <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                  Everyone's live positions &amp; today's pins — right now
                </span>
              </span>
            </Link>
            {/* OWNER ONLY — not the admin tier. Purpose material is personal;
                office staff never see it (owner decision 2026-09-23). */}
            {isOwner && (
              <Link to="/my-purpose" onClick={() => onOpenChange(false)} className={itemCls}>
                <Compass className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  My Purpose
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    Your own purpose profile — the same workshop the sales team gets
                  </span>
                </span>
              </Link>
            )}
            {isOwner && (
              <Link to="/purpose-leadership" onClick={() => onOpenChange(false)} className={itemCls}>
                <Telescope className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Purpose Leadership
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    Coaching command center — every rep's direction and why
                  </span>
                </span>
              </Link>
            )}
            {role === "captain" && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  startCanvasserTutorial();
                }}
                className={itemCls}
              >
                <CircleHelp className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Replay this screen's tips
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    The same walkthrough new players get, for the page you're on
                  </span>
                </span>
              </button>
            )}
            {role === "sales_rep" && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  const search = window.location.search.includes("ck_anim=1")
                    ? window.location.search
                    : `?ck_anim=1`;
                  window.location.assign(window.location.pathname + search);
                }}
                className={itemCls}
              >
                <Sparkles className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Replay the intro
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    The door-kick opening scene — live action at golden hour
                  </span>
                </span>
              </button>
            )}
            {isAdminTier && (
              <Link to="/users" onClick={() => onOpenChange(false)} className={itemCls}>
                <Users className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Manage Players
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    Everyone in one place — roles, vans, invites &amp; logins, cleanup
                  </span>
                </span>
              </Link>
            )}
            {isAdminTier && (
              <Link to="/learn" onClick={() => onOpenChange(false)} className={itemCls}>
                <GraduationCap className="w-4 h-4 shrink-0" />
                <span className="flex-1">Learn</span>
              </Link>
            )}
            {isAdminTier && (
              <Link to="/daily-wrap" onClick={() => onOpenChange(false)} className={itemCls}>
                <Sparkles className="w-4 h-4 shrink-0" />
                <span className="flex-1">Daily Wrap</span>
              </Link>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {canInvite && <InvitePlayerSheet open={inviteOpen} onOpenChange={setInviteOpen} />}
    </>
  );
}
