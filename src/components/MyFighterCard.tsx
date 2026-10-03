// Self-serve fighter photo (Close Kombat — canvassers, owner 2026-10-02). A
// player uploads a selfie and we turn it into their Street Fighter cartoon on
// the spot (Gemini) — the same art the whole board shows next to their name. No
// review gate: it goes live the moment it generates (owner: we iterate later).
// Lives on the canvasser Mission page; any signed-in player sets only their own.

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArcadePanel, NeonButton } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { useAuth } from "@/hooks/useAuth";
import { useRepCartoons, cartoonFor, repCartoonsKey } from "@/hooks/useRepCartoons";
import { uploadMyCanvasserPhotoFn } from "@/lib/canvasser-fighters.functions";
import { fileToResizedDataUrl } from "@/lib/image-upload";

export function MyFighterCard() {
  const { user, displayName } = useAuth();
  const qc = useQueryClient();
  const cartoons = useRepCartoons().data;
  const fileRef = useRef<HTMLInputElement>(null);
  const [prepping, setPrepping] = useState(false);

  const name = displayName ?? "You";
  const mine = cartoonFor(cartoons, displayName);
  const hasFighter = !!mine?.portrait || !!mine?.full;

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

  const busy = prepping || upload.isPending;

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
