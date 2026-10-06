// App-wide background music — "Radio Los Santos" on repeat the whole time a
// signed-in player is in the app (owner ask 2026-10-06), with a mute/unmute
// button in the header. <BackgroundMusic /> is the engine (mounts once in
// AppShell, renders nothing); <MusicToggle /> is the button, rendered in the
// mobile and desktop header slots.
//
// The track itself is licensed music and is NOT committed — drop the MP3 at
// public/audio/radio-los-santos.mp3 (see public/audio/README.md) and the
// whole feature lights up. Until the file loads, everything self-hides: no
// button, no retry loop. Availability fans out through a tiny external store
// because the engine mounts once while two header slots render the button.
//
// Autoplay: browsers refuse un-gestured audio, so the engine tries once on
// mount and otherwise arms window-level gesture listeners that start playback
// on the first tap/keypress — as close to "the entire time" as the web
// allows. Mute pauses the element (no silent-playback battery burn) and
// persists via ti_music_muted_v1; unmute resumes in place. The loop position
// survives a reload through sessionStorage so the song doesn't restart on
// every refresh. Deliberately independent of the arcade-FX sound toggle:
// music defaults ON, FX beeps stay off by default (earlier owner spec).

import { Music } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { setMusicMuted, isMusicMuted } from "@/lib/fx-prefs";
import { useFxPrefs } from "@/hooks/useFxPrefs";

const MUSIC_SRC = "/audio/radio-los-santos.mp3";
const RESUME_KEY = "ti_music_pos_v1";
// Background bed, not a boombox — arcade FX and cutscene audio sit on top.
const MUSIC_VOLUME = 0.35;

const AVAIL_EVENT = "ti-music-avail";
let musicAvailable = false;

function setAvailable(v: boolean): void {
  if (musicAvailable === v) return;
  musicAvailable = v;
  try {
    window.dispatchEvent(new Event(AVAIL_EVENT));
  } catch {
    /* SSR */
  }
}

function subscribeAvail(cb: () => void): () => void {
  window.addEventListener(AVAIL_EVENT, cb);
  return () => window.removeEventListener(AVAIL_EVENT, cb);
}

/** True once the track has actually loaded — the buttons hide until then. */
export function useMusicAvailable(): boolean {
  return useSyncExternalStore(
    subscribeAvail,
    () => musicAvailable,
    () => false,
  );
}

/** The audio engine. Mount once (AppShell, signed-in only); renders nothing. */
export function BackgroundMusic() {
  const { musicMuted } = useFxPrefs();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Flipped by the element's error event (404 before the MP3 is dropped in,
  // codec trouble, …) so the gesture listeners stop poking a dead element.
  const failedRef = useRef(false);

  // Element lifecycle — create once, tear down on sign-out/unmount.
  useEffect(() => {
    const audio = new Audio();
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = MUSIC_VOLUME;
    audioRef.current = audio;

    const onError = () => {
      failedRef.current = true;
      setAvailable(false);
    };
    const onLoaded = () => {
      if (!failedRef.current) setAvailable(true);
    };
    // Resume mid-track after a reload; currentTime only sticks once metadata
    // is in, hence the listener rather than setting it up front.
    const onMeta = () => {
      try {
        const pos = Number(sessionStorage.getItem(RESUME_KEY));
        if (Number.isFinite(pos) && pos > 0 && pos < audio.duration) {
          audio.currentTime = pos;
        }
      } catch {
        /* private mode */
      }
    };
    const savePos = () => {
      try {
        if (audio.currentTime > 0) sessionStorage.setItem(RESUME_KEY, String(audio.currentTime));
      } catch {
        /* private mode */
      }
    };

    audio.addEventListener("error", onError);
    audio.addEventListener("loadeddata", onLoaded);
    audio.addEventListener("loadedmetadata", onMeta, { once: true });
    window.addEventListener("pagehide", savePos);
    document.addEventListener("visibilitychange", savePos);
    audio.src = MUSIC_SRC;

    return () => {
      savePos();
      audio.pause();
      audio.removeEventListener("error", onError);
      audio.removeEventListener("loadeddata", onLoaded);
      window.removeEventListener("pagehide", savePos);
      document.removeEventListener("visibilitychange", savePos);
      audio.removeAttribute("src");
      audioRef.current = null;
      setAvailable(false);
    };
  }, []);

  // Play/pause tracks the mute pref. While unmuted but blocked by the
  // autoplay policy, every gesture retries until playback sticks.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (musicMuted) {
      audio.pause();
      return;
    }

    const start = () => {
      if (failedRef.current || isMusicMuted() || !audio.paused) return;
      audio.play().catch(() => {
        /* still blocked — the next gesture retries */
      });
    };

    start();
    const gestures = ["pointerdown", "keydown"] as const;
    for (const e of gestures) window.addEventListener(e, start);
    const removeGestures = () => {
      for (const e of gestures) window.removeEventListener(e, start);
    };
    audio.addEventListener("playing", removeGestures);
    return () => {
      removeGestures();
      audio.removeEventListener("playing", removeGestures);
    };
  }, [musicMuted]);

  return null;
}

/**
 * Header mute/unmute button. Hidden until the track is loadable; `spacer`
 * keeps the mobile header's equal-width side slots (and thus the centered
 * wordmark) intact by rendering the old 44px spacer instead of nothing.
 */
export function MusicToggle({ className, spacer = false }: { className?: string; spacer?: boolean }) {
  const available = useMusicAvailable();
  const { musicMuted } = useFxPrefs();

  if (!available) return spacer ? <div className="w-11" /> : null;

  return (
    <button
      type="button"
      aria-label={musicMuted ? "Unmute background music" : "Mute background music"}
      aria-pressed={!musicMuted}
      onClick={() => setMusicMuted(!musicMuted)}
      className={cn(
        "relative min-w-11 min-h-11 inline-flex items-center justify-center rounded-md hover:bg-surface-elevated text-muted-foreground hover:text-foreground",
        !musicMuted && "text-neon",
        className,
      )}
    >
      <Music className={cn("w-5 h-5", musicMuted && "opacity-40")} />
      {musicMuted && <span aria-hidden className="absolute h-px w-6 rotate-45 bg-current opacity-60" />}
    </button>
  );
}
