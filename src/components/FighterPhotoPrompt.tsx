// Login nudge (Close Kombat, owner 2026-10-03 / expanded 2026-10-05). "Make sure
// all canvassers, captains, managers are asked to submit a photo next time they
// log in." Shows ONCE per login session to every eligible role that has no
// approved fighter yet, with the same self-serve upload as MyFighterCard.
// Dismissible ("Maybe later") — it comes back on their next login until they
// have a fighter. Mounted globally in AppShell so it reaches whatever screen
// each role lands on; gated on the REAL role (View-As previews never trigger it
// or burn the owner's session flag). Sales reps get their avatar from the Monday
// pipeline, so they're excluded.

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { NeonButton } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";
import { useMyFighterUpload } from "@/hooks/useMyFighterUpload";

const SESSION_KEY = "ti_fighter_prompt_shown";

// Door-knockers + the manager tier (office_staff). Confirmers are canvasser-tier
// but keep their own realRole, so list them explicitly. Reps and bookkeepers are
// out; the owner isn't nudged.
const ELIGIBLE_ROLES = new Set(["canvasser", "confirmer", "captain", "office_staff"]);

export function FighterPhotoPrompt() {
  const { user, displayName, realRole } = useAuth();
  const cartoons = useRepCartoons().data;
  const fileRef = useRef<HTMLInputElement>(null);
  const { onPick, busy } = useMyFighterUpload();
  const [open, setOpen] = useState(false);

  const eligible = !!realRole && ELIGIBLE_ROLES.has(realRole);
  const mine = cartoonFor(cartoons, displayName);
  const hasFighter = !!mine?.portrait || !!mine?.full;

  // Open once per login session for anyone still without a fighter. A short
  // delay keeps it from racing the welcome intro on first paint.
  useEffect(() => {
    if (!user?.id || !eligible || hasFighter) return;
    let shown = false;
    try {
      shown = sessionStorage.getItem(SESSION_KEY) === "1";
    } catch {
      /* private mode — just show it */
    }
    if (shown) return;
    const t = setTimeout(() => {
      setOpen(true);
      try {
        sessionStorage.setItem(SESSION_KEY, "1");
      } catch {
        /* ignore */
      }
    }, 1400);
    return () => clearTimeout(t);
  }, [user?.id, eligible, hasFighter]);

  // The moment their fighter lands (upload finished → cartoon map refreshed),
  // close out.
  useEffect(() => {
    if (hasFighter) setOpen(false);
  }, [hasFighter]);

  if (!user?.id || !eligible) return null;

  const name = displayName ?? "You";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest text-kombat-gold">
            Enter the arena
          </DialogTitle>
          <DialogDescription>
            Upload a photo and we&apos;ll draw you as a fighter — it shows next to your name on
            every board, with your van&apos;s colors behind you.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-4 py-2">
          <RepAvatar
            name={name}
            cartoon={mine}
            variant="full"
            rounded="lg"
            ring
            className="h-20 w-20 shrink-0"
            textClassName="text-xl"
          />
          <p className="text-sm text-muted-foreground">
            {busy ? "Drawing your fighter… a few seconds." : "A clear selfie works best."}
          </p>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void onPick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <DialogFooter className="gap-2 sm:gap-2">
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="min-h-11 rounded-md border border-border bg-surface px-4 text-xs font-display uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            Maybe later
          </button>
          <NeonButton tone="kombat-red" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Working…" : "Upload my photo"}
          </NeonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
