// Second nudge (owner spec 2026-10-06 §4): a home banner for anyone still
// missing a photo. With the gate fully blocking (default) this is rarely seen —
// it matters when an admin has turned "Remind me later" on and a player skipped
// past. Tapping it re-opens the blocking gate (clears this session's snooze via
// the window event ProfilePhotoGate listens for). Self-gates: renders nothing
// unless the signed-in player is in a gated role and has no photo.

import { Camera } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useMyPhotoStatus } from "@/hooks/useMyPhotoStatus";
import { requiresProfilePhoto } from "@/lib/roles";

export function PhotoNeededBanner() {
  const { user, realRole, realDisplayName } = useAuth();
  const eligible = !!user && requiresProfilePhoto(realRole);
  const { hasPhoto, loading } = useMyPhotoStatus(user?.id, realDisplayName);

  if (!eligible || loading || hasPhoto) return null;

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("photo-gate-reopen"))}
      className="mb-4 flex w-full items-center gap-3 rounded-xl border border-kombat-gold/50 bg-kombat-gold/10 px-4 py-3 text-left transition hover:border-kombat-gold"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-kombat-red/20 text-kombat-red">
        <Camera className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-display text-xs uppercase tracking-widest text-kombat-gold">
          Add your photo
        </span>
        <span className="block text-[11px] text-muted-foreground">
          Your face goes on your avatar and the leaderboard. Tap to add it.
        </span>
      </span>
      <span className="shrink-0 rounded-md border border-kombat-gold/50 px-3 py-1.5 font-display text-[10px] uppercase tracking-widest text-kombat-gold">
        Add
      </span>
    </button>
  );
}
