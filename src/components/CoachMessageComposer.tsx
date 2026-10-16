// Coach-message composer (Phase 5) — the owner (anyone) or a captain (own
// van) records up to 60 seconds for one player or the whole crew. The
// recorder is the Dojo's proven MediaRecorder flow (same mime picking + 3Mbps
// cap ⇒ a full 60s clip lands ~23MB, under the bucket ceiling); upload is the
// same resumable TUS path. Sending goes through send_coach_message, which
// expands crew sends and pushes each recipient.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Send, Square, Video } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { pickMimeType } from "@/components/ObjectionDojo";
import { COACH_MAX_SECONDS, sendCoachMessage, uploadCoachBlob } from "@/hooks/useCoachMessages";

const REC_VIDEO_BPS = 3_000_000; // Dojo parity — keeps 60s well under 50MB

export function CoachMessageComposer({
  open,
  onOpenChange,
  recipient,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The preselected player (from their profile page or a trigger row). */
  recipient: { id: string; name: string; teamId: string | null } | null;
}) {
  const { user } = useAuth();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [phase, setPhase] = useState<"idle" | "live" | "preview">("idle");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [toCrew, setToCrew] = useState(false);
  const { mime, ext } = useMemo(pickMimeType, []);

  useEffect(() => {
    if (open) {
      setPhase("idle");
      setBlob(null);
      setText("");
      setToCrew(false);
      setElapsed(0);
    }
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => {
    if (phase === "live" && elapsed >= COACH_MAX_SECONDS) stopRecording();
  }, [elapsed, phase]);

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
        audio: true,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        await videoRef.current.play().catch(() => {});
      }
      chunksRef.current = [];
      const recOpts: MediaRecorderOptions = { videoBitsPerSecond: REC_VIDEO_BPS };
      if (mime) recOpts.mimeType = mime;
      const rec = new MediaRecorder(stream, recOpts);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: mime || "video/webm" });
        setBlob(b);
        stream.getTracks().forEach((t) => t.stop());
        if (videoRef.current) {
          videoRef.current.srcObject = null;
          videoRef.current.muted = false;
          videoRef.current.src = URL.createObjectURL(b);
        }
        setPhase("preview");
      };
      recorderRef.current = rec;
      rec.start();
      setElapsed(0);
      setPhase("live");
    } catch {
      toast.error("Camera/mic blocked — allow access and try again.");
    }
  }
  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  const send = useMutation({
    mutationFn: async () => {
      if (!user?.id || !recipient) throw new Error("Pick a player first");
      if (!blob && text.trim().length < 2) throw new Error("Record a take or write a line");
      let videoPath: string | undefined;
      if (blob) {
        setUploadPct(0);
        videoPath = await uploadCoachBlob("message", user.id, blob, ext, setUploadPct);
      }
      return sendCoachMessage({
        recipientId: toCrew ? undefined : recipient.id,
        teamId: toCrew ? (recipient.teamId ?? undefined) : undefined,
        text: text.trim() || undefined,
        videoPath,
      });
    },
    onSuccess: (sent) => {
      toast.success(
        sent > 1 ? `🎥 Sent to ${sent} players on the van` : `🎥 Sent to ${recipient?.name}`,
      );
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setUploadPct(null),
  });

  if (!recipient) return null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-sm uppercase tracking-widest">
            🎥 Message · {toCrew ? "the whole van" : recipient.name}
          </DialogTitle>
          <DialogDescription>
            Private — only {toCrew ? "the crew" : "they"} can watch it. Max {COACH_MAX_SECONDS}{" "}
            seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-black">
          <video
            ref={videoRef}
            playsInline
            controls={phase === "preview"}
            className="h-full w-full object-contain"
          />
          {phase === "live" && (
            <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-xs font-bold uppercase text-destructive">
              <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" /> REC{" "}
              {COACH_MAX_SECONDS - elapsed}s left
            </div>
          )}
        </div>

        <Textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Optional line under the video — or send text only…"
        />

        {recipient.teamId && (
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={toCrew}
              onChange={(e) => setToCrew(e.target.checked)}
              className="h-5 w-5 accent-[var(--neon)]"
            />
            Send to the whole van instead
          </label>
        )}

        <div className="flex justify-end gap-2">
          {phase === "idle" && (
            <Button variant="outline" onClick={startRecording}>
              <Video className="mr-1.5 h-3.5 w-3.5" /> Record
            </Button>
          )}
          {phase === "live" && (
            <Button variant="destructive" onClick={stopRecording}>
              <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
            </Button>
          )}
          {phase === "preview" && (
            <Button variant="ghost" onClick={startRecording}>
              Re-record
            </Button>
          )}
          <Button onClick={() => send.mutate()} disabled={send.isPending || phase === "live"}>
            {send.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-3.5 w-3.5" />
            )}
            {send.isPending
              ? uploadPct === null
                ? "Sending…"
                : `Uploading… ${uploadPct}%`
              : "Send"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
