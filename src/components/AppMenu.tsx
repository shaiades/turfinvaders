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
import { GraduationCap, Send, Sparkles, Users, CircleHelp } from "lucide-react";

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
            {isAdminTier && (
              <Link to="/users" onClick={() => onOpenChange(false)} className={itemCls}>
                <Users className="w-4 h-4 shrink-0" />
                <span className="flex-1">
                  Manage Players
                  <span className="block normal-case font-sans tracking-normal text-[11px] text-muted-foreground mt-0.5">
                    Roles, vans, invites, account cleanup
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
