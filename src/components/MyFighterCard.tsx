// Self-serve fighter photo (Close Kombat — canvassers, owner 2026-10-02). A
// player uploads a selfie and we turn it into their Street Fighter cartoon on
// the spot (Gemini) — the same art the whole board shows next to their name. No
// review gate: it goes live the moment it generates (owner: we iterate later).
// Lives on the canvasser Mission page; any signed-in player sets only their own.

import { useRef } from "react";
import { ArcadePanel, NeonButton } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";
import { useMyFighterUpload } from "@/hooks/useMyFighterUpload";

export function MyFighterCard() {
  const { user, displayName } = useAuth();
  const cartoons = useRepCartoons().data;
  const fileRef = useRef<HTMLInputElement>(null);
  const { onPick, busy } = useMyFighterUpload();

  const name = displayName ?? "You";
  const mine = cartoonFor(cartoons, displayName);
  const hasFighter = !!mine?.portrait || !!mine?.full;

  if (!user?.id) return null;

  return (
    <ArcadePanel title="Your Fighter" faction="kombat">
      <div className="flex items-center gap-4">
        <RepAvatar
          name={name}
          cartoon={mine}
          variant="full"
          rounded="lg"
          ring
          className="h-20 w-20 shrink-0"
          textClassName="text-xl"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {busy
              ? "Drawing your fighter… this takes a few seconds."
              : hasFighter
                ? "This is you on the board. Upload a new photo anytime to redraw it."
                : "Upload a selfie and we'll draw you as a fighter — it shows next to your name everywhere."}
          </p>
          <div className="mt-3">
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
            <NeonButton tone="kombat-red" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? "Working…" : hasFighter ? "Change my photo" : "Upload my photo"}
            </NeonButton>
          </div>
        </div>
      </div>
    </ArcadePanel>
  );
}
