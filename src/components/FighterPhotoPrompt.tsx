// Sign-in photo request (Close Kombat, owner 2026-10-03; app-wide 2026-10-05).
// "Next time they go to sign in, request a selfie — or any picture they want."
// Mounted once in AppShell so it fires right after login on whatever page the
// crew lands on. Shows ONCE per login session to the selfie-sourced crew
// (canvassers, confirmers, captains, office_staff "Managers" — see
// requiresFighterSelfie) who have no fighter yet, using the same self-serve
// upload as MyFighterCard. Skippable ("Maybe later") and it returns every login
// until they have one; reps (Monday-sourced) and the owner never see it. Gated
// on the REAL role so View-As previews never trigger it or burn the session
// flag, and held behind the first-open cutscenes via `heldBack` so it never
// stacks on the intro / EOD recap.

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
import { requiresFighterSelfie } from "@/lib/roles";

const SESSION_KEY = "ti_fighter_prompt_shown";

/** `?fighter_prompt=1` force-opens the request from ANY account for a preview,
 *  ignoring role / fighter-status / once-per-session (matches the other
 *  first-open overlays' `?*_anim` / `?*_demo` flags). Never stamps anything. */
export function isFighterPromptForced(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("fighter_prompt");
  } catch {
    return false;
  }
}

export function FighterPhotoPrompt({ heldBack = false }: { heldBack?: boolean }) {
  // Gate on the REAL role so an owner previewing View As → canvasser is never
  // asked (the owner is exempt), matching the other first-open overlays.
  const { user, realRole, displayName } = useAuth();
  const cartoonsQuery = useRepCartoons();
  const cartoons = cartoonsQuery.data;
  const fileRef = useRef<HTMLInputElement>(null);
  const { onPick, busy } = useMyFighterUpload();
  const [open, setOpen] = useState(false);

  const forced = isFighterPromptForced();
  const eligible = forced || (!!user?.id && requiresFighterSelfie(realRole));
  const mine = cartoonFor(cartoons, displayName);
  const hasFighter = !!mine?.portrait || !!mine?.full;

  // Open once per login session for eligible crew still without a fighter —
  // once the cartoon map has actually loaded (so someone who HAS a fighter is
  // never asked during the brief load) and the first-open cutscenes are done.
  // A forced preview skips every gate and just opens.
  useEffect(() => {
    if (forced) {
      setOpen(true);
      return;
    }
    if (!eligible || heldBack || hasFighter) return;
    if (cartoons === undefined) return; // wait for the cartoon map
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
  }, [forced, eligible, heldBack, hasFighter, cartoons]);

  // The moment their fighter lands (upload finished → cartoon map refreshed),
  // close out — but keep a forced preview open so it can be inspected.
  useEffect(() => {
    if (!forced && hasFighter) setOpen(false);
  }, [forced, hasFighter]);

  if (!eligible) return null;

  const name = displayName ?? "You";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest text-kombat-gold">
            Enter the arena
          </DialogTitle>
          <DialogDescription>
            Add a photo — a selfie or any pic you like — and we&apos;ll draw you as a fighter. It
            shows next to your name on every board, with your van&apos;s colors behind you.
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
            {busy
              ? "Drawing your fighter… a few seconds."
              : "Any photo works — a clear one of your face looks best."}
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
