// Shared "set my own fighter from a selfie" flow (Close Kombat — canvassers).
// Used by MyFighterCard (the persistent Mission control) and FighterPhotoPrompt
// (the login nudge) so both pick the file, downscale it client-side, upload +
// generate, and refresh the cartoon map identically.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { repCartoonsKey } from "@/hooks/useRepCartoons";
import { uploadMyCanvasserPhotoFn } from "@/lib/canvasser-fighters.functions";
import { fileToResizedDataUrl } from "@/lib/image-upload";

export function useMyFighterUpload() {
  const qc = useQueryClient();
  const [prepping, setPrepping] = useState(false);

  const upload = useMutation({
    mutationFn: async (dataUrl: string) => uploadMyCanvasserPhotoFn({ data: { dataUrl } }),
    onSuccess: (r) => {
      if (r.ok) {
        toast.success("Your fighter is live! 🥊");
        void qc.invalidateQueries({ queryKey: repCartoonsKey });
      } else {
        toast.error(`Couldn't generate your fighter: ${r.error ?? "try another photo"}`);
      }
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Upload failed"),
  });

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setPrepping(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      setPrepping(false);
      upload.mutate(dataUrl);
    } catch (e) {
      setPrepping(false);
      toast.error(e instanceof Error ? e.message : "Couldn't read that photo");
    }
  };

  return { onPick, busy: prepping || upload.isPending };
}
