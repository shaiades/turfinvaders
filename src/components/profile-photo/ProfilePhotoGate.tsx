// The blocking "Snap your fighter photo" step (owner directive 2026-10-06:
// "the photo step has to be obvious for every user"). A full-screen arcade
// overlay that drops right after login on ANY gated player (canvasser,
// confirmer, captain, sales rep, Manager) who has no photo yet, covering the
// whole app — nav included — until a photo is saved. No skip button by default.
//
// Why this replaces the old FighterPhotoPrompt: that was a small, dismissible
// dialog shown once per session, held UNDER the first-open cutscenes, and it
// never fired for sales reps at all — a canvasser like Jose Miranda could tap
// it away (or the backdrop) once and never see it again, with only his initials
// hinting anything was missing. This one blocks.
//
//  §1 blocking screen · §2 game style (arcade bg, glowing frame, silhouette +
//  pulsing "?") · §3 crop & confirm (PhotoCropper) · §6 never a dead screen
//  (every failure gets Try again + Text Shai). The "fighter unlocked" burst
//  plays on save. Gated on the REAL role so an owner's View-As preview never
//  triggers it. Previews: ?photo_gate=1 (blocking) · =error · =unlocked.

import { useEffect, useRef, useState } from "react";
import { Camera, ImageUp, AlertTriangle } from "lucide-react";
import confetti from "canvas-confetti";
import { useAuth } from "@/hooks/useAuth";
import { useMyPhotoStatus } from "@/hooks/useMyPhotoStatus";
import { usePhotoGateConfig } from "@/hooks/usePhotoGateConfig";
import { useMyFighterUpload } from "@/hooks/useMyFighterUpload";
import { useRepCartoons, cartoonFor } from "@/hooks/useRepCartoons";
import { requiresProfilePhoto } from "@/lib/roles";
import { RepAvatar } from "@/components/RepAvatar";
import { NeonButton } from "@/components/arcade";
import { PhotoCropper } from "@/components/profile-photo/PhotoCropper";

const SHOWS_KEY = "ti_photo_gate_shows"; // per-device count of gate appearances
const SNOOZE_KEY = "ti_photo_gate_snoozed"; // this login session, remind-later tapped

type ForcedMode = "blocking" | "error" | "unlocked" | null;
function forcedMode(): ForcedMode {
  try {
    const v = new URLSearchParams(window.location.search).get("photo_gate");
    if (v === null) return null;
    if (v === "error") return "error";
    if (v === "unlocked") return "unlocked";
    return "blocking"; // ?photo_gate=1 / anything else
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function ProfilePhotoGate({
  onActiveChange,
}: {
  /** Reports whether the gate owns the screen (or is still deciding for a gated
   *  player) so AppShell can hold the first-open cutscenes behind it — the photo
   *  step is the top-priority moment, not one more thing in the stack. */
  onActiveChange?: (active: boolean) => void;
}) {
  const { user, realRole, realDisplayName } = useAuth();
  const forced = typeof window !== "undefined" ? forcedMode() : null;

  const eligibleRole = !!user && requiresProfilePhoto(realRole);
  const { hasPhoto, loading } = useMyPhotoStatus(user?.id, realDisplayName);
  const cfg = usePhotoGateConfig(eligibleRole && !hasPhoto && !loading);
  const cartoons = useRepCartoons().data;

  // phase drives what's on screen. "hidden" → nothing; "blocking" → the full
  // step; "unlocked" → the celebratory burst that plays before we step aside.
  const [phase, setPhase] = useState<"hidden" | "blocking" | "unlocked">("hidden");
  const [step, setStep] = useState<"intro" | "crop">("intro");
  const [pickedSrc, setPickedSrc] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  const { submitDataUrl, busy, error, clearError } = useMyFighterUpload({
    silent: true,
    onSuccess: () => {
      revokePicked();
      setStep("intro");
      setPhase("unlocked");
    },
  });

  function revokePicked() {
    setPickedSrc((cur) => {
      if (cur && cur.startsWith("blob:")) URL.revokeObjectURL(cur);
      return null;
    });
  }

  // The need: a gated player, not loading, no photo, not snoozed this session,
  // and not held behind a first-open cutscene. `snoozed` is stateful so the
  // home "Add your photo" banner can re-open the gate via a window event.
  const [snoozed, setSnoozed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SNOOZE_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const reopen = () => {
      try {
        sessionStorage.removeItem(SNOOZE_KEY);
      } catch {
        /* ignore */
      }
      setSnoozed(false);
    };
    window.addEventListener("photo-gate-reopen", reopen);
    return () => window.removeEventListener("photo-gate-reopen", reopen);
  }, []);
  const needsPhoto = eligibleRole && !loading && !hasPhoto && !snoozed;

  // Tell AppShell to hold the first-open cutscenes while we're on screen OR
  // still deciding for an eligible, un-snoozed player — closing the brief
  // load-window race where a cutscene could burn its once-ever flag underneath
  // the gate. A forced preview only reports its own visibility.
  const gateBusy =
    phase !== "hidden" || (!forced && eligibleRole && !snoozed && (loading || !hasPhoto));
  useEffect(() => {
    onActiveChange?.(gateBusy);
  }, [gateBusy, onActiveChange]);

  // Raise / lower the blocking screen as the need changes. A forced preview
  // overrides everything and never stamps.
  useEffect(() => {
    if (forced) {
      setPhase(forced === "unlocked" ? "unlocked" : "blocking");
      return;
    }
    if (phase === "unlocked") return; // let the burst finish
    if (needsPhoto && phase === "hidden") {
      setPhase("blocking");
      try {
        const n = Number(localStorage.getItem(SHOWS_KEY) ?? "0") + 1;
        localStorage.setItem(SHOWS_KEY, String(n));
      } catch {
        /* private mode — no counter */
      }
    } else if (!needsPhoto && phase === "blocking") {
      setPhase("hidden");
    }
  }, [forced, needsPhoto, phase]);

  // Force the error state for a preview.
  useEffect(() => {
    if (forced === "error" && !error) clearError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forced]);

  // "Fighter unlocked" — confetti + auto step-aside.
  useEffect(() => {
    if (phase !== "unlocked") return;
    if (!prefersReducedMotion()) {
      void confetti({
        particleCount: 120,
        spread: 75,
        origin: { y: 0.4 },
        colors: ["#e11d2a", "#f5c518", "#ffffff"],
        disableForReducedMotion: true,
      });
    }
    const t = setTimeout(() => {
      if (!forced) setPhase("hidden");
    }, 2600);
    return () => clearTimeout(t);
  }, [phase, forced]);

  if (phase === "hidden") return null;

  const name = realDisplayName ?? "You";
  const mine = cartoonFor(cartoons, realDisplayName);
  const showsCount = (() => {
    try {
      return Number(localStorage.getItem(SHOWS_KEY) ?? "0");
    } catch {
      return 0;
    }
  })();
  const canRemindLater = !forced && cfg.data?.remindLaterEnabled === true && showsCount >= 3;
  const showError = forced === "error" || !!error;

  const onFilePicked = (file: File | undefined) => {
    if (!file) return;
    clearError();
    const src = URL.createObjectURL(file);
    setPickedSrc(src);
    setStep("crop");
  };

  const remindLater = () => {
    try {
      sessionStorage.setItem(SNOOZE_KEY, "1");
    } catch {
      /* ignore */
    }
    setSnoozed(true);
    setPhase("hidden");
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add your fighter photo"
      className="fixed inset-0 z-[9990] flex flex-col overflow-y-auto bg-kombat-black px-safe pt-safe pb-safe"
    >
      {/* Arcade backdrop: deep black with a faint red/gold vignette + grid. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, color-mix(in oklab, var(--kombat-red) 22%, transparent) 0%, transparent 55%), radial-gradient(90% 70% at 50% 100%, color-mix(in oklab, var(--kombat-gold) 14%, transparent) 0%, transparent 60%)",
        }}
      />

      <div className="relative mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-5 py-10">
        {phase === "unlocked" ? (
          <UnlockedCard name={name} cartoon={mine} fallbackSrc={pickedSrc} />
        ) : step === "crop" && pickedSrc ? (
          <div className="space-y-5">
            <h1 className="text-center font-display text-lg uppercase tracking-widest text-kombat-gold">
              Frame your face
            </h1>
            <PhotoCropper
              imageSrc={pickedSrc}
              busy={busy}
              onRetake={() => {
                revokePicked();
                setStep("intro");
              }}
              onConfirm={(dataUrl) => submitDataUrl(dataUrl)}
            />
            {showError && <ErrorPanel message={error} onRetry={() => setStep("intro")} />}
          </div>
        ) : (
          <>
            {/* §2 silhouette avatar with a pulsing "?" inside a glowing frame */}
            <div className="flex flex-col items-center gap-4">
              <div className="photo-gate-frame relative flex h-36 w-36 items-center justify-center rounded-full border-2 border-kombat-gold/70 bg-black/60">
                <svg viewBox="0 0 24 24" className="h-24 w-24 text-kombat-red/50" aria-hidden>
                  <path
                    fill="currentColor"
                    d="M12 12.75a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5ZM4.5 20.25a7.5 7.5 0 0 1 15 0 .75.75 0 0 1-.75.75H5.25a.75.75 0 0 1-.75-.75Z"
                  />
                </svg>
                <span className="photo-gate-q absolute font-display text-5xl font-bold text-kombat-gold">
                  ?
                </span>
              </div>
              <h1 className="text-center font-display text-2xl uppercase tracking-widest text-foreground">
                Snap your fighter photo
              </h1>
              <p className="max-w-xs text-center text-sm text-muted-foreground">
                Your face goes on your avatar and the leaderboard. Add one to enter the arena.
              </p>
            </div>

            {showError && <ErrorPanel message={error} onRetry={clearError} />}

            {/* §1 big camera button + upload-from-library */}
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={busy}
                className="flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border-2 border-kombat-red bg-kombat-red/15 font-display text-sm uppercase tracking-widest text-kombat-red shadow-neon-red transition active:translate-y-px disabled:opacity-50"
              >
                <Camera className="h-6 w-6" />
                {busy ? "Working…" : "Take a photo"}
              </button>
              <button
                type="button"
                onClick={() => libraryRef.current?.click()}
                disabled={busy}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-border bg-surface/60 font-display text-xs uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <ImageUp className="h-5 w-5" /> Upload from library
              </button>

              {canRemindLater && (
                <button
                  type="button"
                  onClick={remindLater}
                  className="mx-auto block pt-1 text-center text-[11px] uppercase tracking-widest text-muted-foreground/70 underline underline-offset-4 hover:text-muted-foreground"
                >
                  Remind me later
                </button>
              )}
              <p className="pt-1 text-center text-[11px] text-muted-foreground/70">
                Front camera on phones. A clear shot of your face works best.
              </p>
            </div>
          </>
        )}
      </div>

      {/* capture="user" → front camera on phones; a plain picker everywhere else */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={(e) => {
          onFilePicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          onFilePicked(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** §6 — never a dead screen: a clear error with Try again + Text Shai. */
function ErrorPanel({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-center">
      <div className="mb-1 flex items-center justify-center gap-2 font-display text-xs uppercase tracking-widest text-destructive">
        <AlertTriangle className="h-4 w-4" /> Couldn&apos;t save that photo
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        {message || "Something went wrong. Check your connection and try again."}
      </p>
      <div className="flex flex-col items-center gap-2">
        <NeonButton tone="kombat-gold" onClick={onRetry}>
          Try again
        </NeonButton>
        <a
          href="sms:+1?&body=Hi%20Shai%2C%20I%20can%27t%20add%20my%20Turf%20Invaders%20photo."
          className="text-[11px] uppercase tracking-widest text-muted-foreground/70 underline underline-offset-4 hover:text-muted-foreground"
        >
          Text Shai for help
        </a>
      </div>
    </div>
  );
}

/** The "fighter unlocked" payoff. Shows the live cartoon the instant it's ready,
 *  otherwise the photo they just cropped — the win lands immediately either way. */
function UnlockedCard({
  name,
  cartoon,
  fallbackSrc,
}: {
  name: string;
  cartoon: ReturnType<typeof cartoonFor>;
  fallbackSrc: string | null;
}) {
  const hasCartoon = !!cartoon?.full || !!cartoon?.portrait;
  return (
    <div className="photo-gate-pop flex flex-col items-center gap-5 text-center">
      <div className="relative h-44 w-44 overflow-hidden rounded-2xl border-2 border-kombat-gold shadow-neon-gold">
        {hasCartoon ? (
          <RepAvatar
            name={name}
            cartoon={cartoon}
            variant="full"
            rounded="none"
            className="h-full w-full"
            textClassName="text-3xl"
          />
        ) : fallbackSrc ? (
          <img src={fallbackSrc} alt={name} className="h-full w-full object-cover" />
        ) : (
          <RepAvatar name={name} variant="full" rounded="none" className="h-full w-full" />
        )}
      </div>
      <div>
        <div className="font-display text-2xl uppercase tracking-widest text-kombat-gold">
          Fighter Unlocked
        </div>
        <div className="mt-1 font-display text-sm uppercase tracking-widest text-foreground">
          {name}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {hasCartoon
            ? "You're on the board."
            : "Drawing your fighter… it'll appear on the board shortly."}
        </p>
      </div>
    </div>
  );
}
