import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Eye, Loader2, Send, Square, Video } from "lucide-react";

/**
 * Objection Dojo (owner request 2026-08-14): record yourself handling the
 * classic objections; a Manager or Owner approves before an attempt goes
 * live for the whole company to watch. Recordings live in the PRIVATE
 * objection-attempts storage bucket (playback via short-lived signed URLs);
 * rows in objection_attempts carry the pending → approved | denied state.
 *
 * The objections/objection_attempts tables arrive via the hand-applied
 * migration 20260815010000_objection_dojo.sql — until the owner runs it,
 * the queries fail and this section renders a quiet "not unlocked yet"
 * card instead of erroring the page.
 */

export type Objection = {
  id: string;
  title: string;
  prompt: string | null;
  sort: number;
  active: boolean;
};

export type ObjectionAttempt = {
  id: string;
  objection_id: string;
  canvasser_id: string;
  storage_path: string;
  status: "pending" | "approved" | "denied";
  deny_reason: string | null;
  created_at: string;
};

const BUCKET = "objection-attempts";
const MAX_SECONDS = 90;

// New tables aren't in the generated Database types until the migration is
// applied and types are regenerated — one untyped escape hatch, cast on read.
export const dojoTable = (name: string) =>
  (supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> }).from(name);

export function useObjections() {
  return useQuery({
    queryKey: ["objections"],
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await dojoTable("objections")
        .select("*")
        .eq("active", true)
        .order("sort");
      if (error) throw error;
      return (data ?? []) as unknown as Objection[];
    },
  });
}

export function ObjectionDojo() {
  const { user } = useAuth();
  const objections = useObjections();

  // RLS scopes this to: approved rows + the caller's own (+ everything for
  // Owners/Managers) — no client-side status filter needed for visibility.
  const attempts = useQuery({
    enabled: !!user && objections.isSuccess,
    queryKey: ["objection_attempts", "visible", user?.id],
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await dojoTable("objection_attempts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as ObjectionAttempt[];
    },
  });

  const [recordFor, setRecordFor] = useState<Objection | null>(null);
  const [watchFor, setWatchFor] = useState<Objection | null>(null);

  if (objections.isError) {
    return (
      <ArcadePanel title="Objection Dojo">
        <p className="text-sm text-muted-foreground">
          The Dojo isn't unlocked yet — an Owner still needs to run its database migration.
        </p>
      </ArcadePanel>
    );
  }

  const byObjection = new Map<string, ObjectionAttempt[]>();
  for (const a of attempts.data ?? []) {
    const arr = byObjection.get(a.objection_id) ?? [];
    arr.push(a);
    byObjection.set(a.objection_id, arr);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-sm uppercase tracking-[0.25em] text-neon">
          Objection Dojo
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Record yourself handling these objections. Watch how others crush it. Submissions go live
          once a Manager or Owner approves them.
        </p>
      </div>

      {objections.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading objections…</div>
      ) : (
        <div className="grid gap-4">
          {(objections.data ?? []).map((o) => {
            const all = byObjection.get(o.id) ?? [];
            const approved = all.filter((a) => a.status === "approved");
            const mine = all.filter((a) => a.canvasser_id === user?.id);
            const minePending = mine.filter((a) => a.status === "pending").length;
            return (
              <div
                key={o.id}
                className="relative overflow-hidden rounded-lg border border-[color-mix(in_oklab,var(--accent)_35%,var(--border))] bg-[color-mix(in_oklab,var(--accent)_5%,var(--surface))] p-5"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-display text-base text-foreground">{o.title}</div>
                    {o.prompt && <p className="mt-1 text-xs text-muted-foreground">{o.prompt}</p>}
                  </div>
                  <span className="shrink-0 text-[10px] font-display uppercase tracking-widest text-muted-foreground border border-border rounded-full px-2.5 py-1">
                    <Eye className="inline w-3 h-3 mr-1 -mt-0.5" />
                    {approved.length} live
                  </span>
                </div>
                <div className="mt-4 flex items-center gap-2 flex-wrap">
                  <Button onClick={() => setRecordFor(o)}>
                    <Video className="w-3.5 h-3.5 mr-1.5" /> Record Attempt
                  </Button>
                  <Button
                    variant="outline"
                    disabled={approved.length === 0}
                    onClick={() => setWatchFor(o)}
                  >
                    <Eye className="w-3.5 h-3.5 mr-1.5" /> Watch
                  </Button>
                  {minePending > 0 && (
                    <span className="text-[10px] font-display uppercase tracking-widest text-warning">
                      {minePending} of yours awaiting review
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {recordFor && user && (
        <RecordAttemptDialog
          objection={recordFor}
          userId={user.id}
          onClose={() => setRecordFor(null)}
        />
      )}
      {watchFor && (
        <WatchDialog
          objection={watchFor}
          attempts={(byObjection.get(watchFor.id) ?? []).filter((a) => a.status === "approved")}
          onClose={() => setWatchFor(null)}
        />
      )}
    </div>
  );
}

/* ============ Recording ============ */

function pickMimeType(): { mime: string; ext: string } {
  if (typeof MediaRecorder === "undefined") return { mime: "", ext: "webm" };
  // Safari records mp4; Chrome/Android prefer webm.
  if (MediaRecorder.isTypeSupported("video/mp4")) return { mime: "video/mp4", ext: "mp4" };
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus"))
    return { mime: "video/webm;codecs=vp8,opus", ext: "webm" };
  return { mime: "video/webm", ext: "webm" };
}

function RecordAttemptDialog({
  objection,
  userId,
  onClose,
}: {
  objection: Objection;
  userId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [phase, setPhase] = useState<"idle" | "live" | "preview">("idle");
  const [blob, setBlob] = useState<Blob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const { mime, ext } = useMemo(pickMimeType, []);

  useEffect(() => {
    return () => {
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === "live" && elapsed >= MAX_SECONDS) stopRecording();
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
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
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

  const submit = useMutation({
    mutationFn: async () => {
      if (!blob) throw new Error("Nothing recorded yet");
      const path = `${userId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, blob, { contentType: blob.type || "video/webm" });
      if (upErr) throw upErr;
      const { error } = await dojoTable("objection_attempts").insert({
        objection_id: objection.id,
        canvasser_id: userId,
        storage_path: path,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Attempt submitted — a Manager or Owner will review it");
      qc.invalidateQueries({ queryKey: ["objection_attempts"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest text-sm">
            Record Attempt · {objection.title}
          </DialogTitle>
          <DialogDescription>
            {objection.prompt ?? "Show how you'd handle it at the door."} Max {MAX_SECONDS} seconds.
          </DialogDescription>
        </DialogHeader>

        <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black aspect-video">
          <video
            ref={videoRef}
            playsInline
            controls={phase === "preview"}
            className="w-full h-full object-contain"
          />
          {phase === "live" && (
            <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-[10px] font-display uppercase tracking-widest text-destructive">
              <span className="w-2 h-2 rounded-full bg-destructive animate-pulse" /> REC{" "}
              {MAX_SECONDS - elapsed}s left
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          {phase === "idle" && (
            <Button onClick={startRecording}>
              <Video className="w-3.5 h-3.5 mr-1.5" /> Start Recording
            </Button>
          )}
          {phase === "live" && (
            <Button variant="destructive" onClick={stopRecording}>
              <Square className="w-3.5 h-3.5 mr-1.5" /> Stop
            </Button>
          )}
          {phase === "preview" && (
            <>
              <Button variant="ghost" onClick={startRecording}>
                Re-record
              </Button>
              <Button onClick={() => submit.mutate()} disabled={submit.isPending}>
                {submit.isPending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                )}
                {submit.isPending ? "Uploading…" : "Submit for Review"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ============ Watching ============ */

export function useAttemptNames(attempts: ObjectionAttempt[]) {
  const ids = useMemo(
    () => Array.from(new Set(attempts.map((a) => a.canvasser_id))).sort(),
    [attempts],
  );
  return useQuery({
    enabled: ids.length > 0,
    queryKey: ["objection_attempt_names", ids.join(",")],
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.id, p.display_name ?? "Unknown"]));
    },
  });
}

export async function signedAttemptUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw error ?? new Error("Couldn't open the video");
  return data.signedUrl;
}

function WatchDialog({
  objection,
  attempts,
  onClose,
}: {
  objection: Objection;
  attempts: ObjectionAttempt[];
  onClose: () => void;
}) {
  const names = useAttemptNames(attempts);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);

  async function play(a: ObjectionAttempt) {
    try {
      setPlaying({ id: a.id, url: await signedAttemptUrl(a.storage_path) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest text-sm">
            Watch · {objection.title}
          </DialogTitle>
          <DialogDescription>Approved answers from the team.</DialogDescription>
        </DialogHeader>

        {playing && (
          <video
            src={playing.url}
            controls
            autoPlay
            playsInline
            className="w-full rounded-lg border border-border bg-black aspect-video object-contain"
          />
        )}

        <ul className="divide-y divide-border max-h-64 overflow-y-auto">
          {attempts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => play(a)}
                className={`w-full text-left py-2.5 px-2 rounded hover:bg-surface flex items-center justify-between gap-3 ${
                  playing?.id === a.id ? "bg-surface" : ""
                }`}
              >
                <span className="min-w-0 truncate text-sm">
                  {names.data?.get(a.canvasser_id) ?? "…"}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {new Date(a.created_at).toLocaleDateString()}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
