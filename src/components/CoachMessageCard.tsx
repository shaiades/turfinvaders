// "Message from Shai" (Phase 5) — a full-screen private-video card on the
// next app open while a message is unseen. Sequenced by AppShell's heldBack
// chain (after the morning intro and the photo gate — it never buries the
// onboarding overlays). SEEN is honest: a video message is marked seen when
// playback STARTS (text-only on close) — closing without playing brings it
// back next open. One-tap exit paths: an emoji reaction or a short voice
// reply, both landing straight back on the sender's row.

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, X } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import {
  REPLY_MAX_SECONDS,
  signedCoachUrl,
  uploadCoachBlob,
  useMarkCoachMessage,
  useUnseenCoachMessage,
} from "@/hooks/useCoachMessages";
import { haptic } from "@/lib/arcade-fx";

const REACTIONS = ["💪", "🔥", "🫡", "❤️"] as const;

export function CoachMessageCard({ heldBack = false }: { heldBack?: boolean }) {
  const { user, previewCanvasserId } = useAuth();
  // Never in View As — the unseen flag belongs to the player.
  const userId = previewCanvasserId ? undefined : user?.id;
  const msg = useUnseenCoachMessage(userId);
  const mark = useMarkCoachMessage(userId);

  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const seenFiredRef = useRef(false);

  // Voice reply (audio-only MediaRecorder — one breath, 30s cap).
  const [recPhase, setRecPhase] = useState<"idle" | "live" | "sending">("idle");
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [elapsed, setElapsed] = useState(0);

  const m = msg.data;
  const open = !!userId && !!m && !heldBack && dismissed !== m.id;

  useEffect(() => {
    seenFiredRef.current = false;
    setVideoUrl(null);
    setRecPhase("idle");
    if (!open || !m?.video_path) return;
    let cancelled = false;
    signedCoachUrl(m.video_path)
      .then((u) => {
        if (!cancelled) setVideoUrl(u);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm per message
  }, [m?.id, open]);

  useEffect(() => {
    if (recPhase !== "live") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [recPhase]);
  useEffect(() => {
    if (recPhase === "live" && elapsed >= REPLY_MAX_SECONDS) stopReply();
  }, [elapsed, recPhase]);

  if (!open || !m) return null;

  const markSeenOnce = () => {
    if (seenFiredRef.current) return;
    seenFiredRef.current = true;
    mark.mutate({ id: m.id, seen: true });
  };

  const close = () => {
    // Text-only messages are "played" by reading them; videos only burn the
    // unseen flag once playback actually started.
    if (!m.video_path) markSeenOnce();
    setDismissed(m.id);
  };

  const react = (emoji: string) => {
    haptic(15);
    markSeenOnce();
    mark.mutate(
      { id: m.id, reaction: emoji, seen: true },
      { onSuccess: () => toast(`${emoji} sent back to ${m.senderName}`, { duration: 2000 }) },
    );
    setDismissed(m.id);
  };

  async function startReply() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const mime = MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType: mime });
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendReply(
          new Blob(chunksRef.current, { type: mime }),
          mime.includes("mp4") ? "m4a" : "webm",
        );
      };
      recRef.current = rec;
      rec.start();
      setElapsed(0);
      setRecPhase("live");
    } catch {
      toast.error("Mic blocked — allow access and try again.");
    }
  }
  function stopReply() {
    if (recRef.current?.state === "recording") recRef.current.stop();
  }
  async function sendReply(blob: Blob, ext: string) {
    if (!userId || !m) return;
    setRecPhase("sending");
    try {
      const path = await uploadCoachBlob("reply", userId, blob, ext);
      markSeenOnce();
      await mark.mutateAsync({ id: m.id, replyPath: path, seen: true });
      toast(`🎙️ Reply sent to ${m.senderName}`, { duration: 2000 });
      setDismissed(m.id);
    } catch (e) {
      toast.error((e as Error).message || "Couldn't send the reply");
      setRecPhase("idle");
    }
  }

  return (
    <div className="fixed inset-0 z-[10018] flex items-center justify-center bg-black/85 px-4 pb-safe pt-safe">
      <div className="w-full max-w-md rounded-2xl border border-neon/50 bg-surface p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-display text-[10px] uppercase tracking-[0.25em] text-neon">
              🎥 Message from {m.senderName}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {m.team_id ? "To the whole van" : "Just for you"} ·{" "}
              {new Date(m.created_at).toLocaleDateString()}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close — it'll come back next open if unplayed"
            onClick={close}
            className="-m-1 flex h-9 w-9 shrink-0 items-center justify-center rounded text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {m.video_path &&
          (videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              playsInline
              onPlay={markSeenOnce}
              className="mt-3 aspect-video w-full rounded-lg border border-border bg-black object-contain"
            />
          ) : (
            <div className="mt-3 flex aspect-video w-full items-center justify-center rounded-lg border border-border bg-black">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ))}
        {m.text && <p className="mt-3 text-base font-medium leading-snug">{m.text}</p>}

        {/* One-tap replies */}
        <div className="mt-4 flex items-center gap-2">
          {recPhase === "idle" && (
            <>
              {REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-label={`React ${e}`}
                  onClick={() => react(e)}
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-foreground/5 text-xl"
                >
                  {e}
                </button>
              ))}
              <button
                type="button"
                onClick={startReply}
                className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-full border border-neon/50 bg-neon/10 px-3 text-xs font-bold uppercase text-neon"
              >
                <Mic className="h-4 w-4" /> Voice reply
              </button>
            </>
          )}
          {recPhase === "live" && (
            <button
              type="button"
              onClick={stopReply}
              className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-destructive bg-destructive/15 px-3 text-xs font-bold uppercase text-destructive"
            >
              <Square className="h-4 w-4" /> Recording… {REPLY_MAX_SECONDS - elapsed}s — tap to send
            </button>
          )}
          {recPhase === "sending" && (
            <div className="inline-flex min-h-11 w-full items-center justify-center gap-2 text-xs font-bold uppercase text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Sending reply…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
