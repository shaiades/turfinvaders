// Shared "set my own fighter from a selfie" flow (Close Kombat — field crew and
// reps alike). Used by FighterCard (the persistent Mission control), and the
// blocking ProfilePhotoGate. Both pick/crop an image, hand us a compact data
// URL, and we upload + generate + refresh the cartoon map identically.
//
//  - onPick(file)        — downscale a raw File and upload (FighterCard's tap).
//  - submitDataUrl(url)  — upload an already-prepared (cropped+compressed) data
//                          URL (the gate's circle-crop output).
// The gate needs to know success/failure to play its "fighter unlocked"
// animation or show a retry, so we surface `error` and an optional onSuccess.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { repCartoonsKey } from "@/hooks/useRepCartoons";
import { myPhotoStatusKey } from "@/hooks/useMyPhotoStatus";
import { uploadMyCanvasserPhotoFn } from "@/lib/canvasser-fighters.functions";
import { fileToResizedDataUrl } from "@/lib/image-upload";

export function useMyFighterUpload(opts?: { onSuccess?: () => void; silent?: boolean }) {
  const qc = useQueryClient();
  const [prepping, setPrepping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = useMutation({
    mutationFn: async (dataUrl: string) => uploadMyCanvasserPhotoFn({ data: { dataUrl } }),
    onSuccess: (r) => {
      if (r.ok) {
        setError(null);
        if (!opts?.silent) toast.success("Your fighter is live! 🥊");
        // The photo row exists the instant the upload lands (before the cartoon
        // even finishes), so both the gate's "has photo" check and every avatar
        // refresh together.
        void qc.invalidateQueries({ queryKey: repCartoonsKey });
        void qc.invalidateQueries({ queryKey: myPhotoStatusKey });
        opts?.onSuccess?.();
      } else {
        const msg = r.error ?? "Try another photo";
        setError(msg);
        if (!opts?.silent) toast.error(`Couldn't generate your fighter: ${msg}`);
      }
    },
    onError: (e) => {
      const msg = e instanceof Error ? e.message : "Upload failed";
      setError(msg);
      if (!opts?.silent) toast.error(msg);
    },
  });

  /** Upload an already-prepared (cropped + compressed) image data URL. */
  const submitDataUrl = (dataUrl: string) => {
    setError(null);
    upload.mutate(dataUrl);
  };

  /** Downscale a raw picked File, then upload (no crop step). */
  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setPrepping(true);
    setError(null);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setPrepping(false);
      upload.mutate(dataUrl);
    } catch (e) {
      setPrepping(false);
      const msg = e instanceof Error ? e.message : "Couldn't read that photo";
      setError(msg);
      if (!opts?.silent) toast.error(msg);
    }
  };

  return {
    onPick,
    submitDataUrl,
    busy: prepping || upload.isPending,
    error,
    clearError: () => setError(null),
  };
}
