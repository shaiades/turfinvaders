// Message from Shai (Phase 5) — data layer. coach_messages rows are one per
// recipient (crew sends pre-expanded by the RPC); recipients read their own
// (RLS), senders see what they sent. Reads fail open to empty until the
// migration lands (the Dojo doctrine). Videos live in the private
// coach-videos bucket behind short-lived signed URLs.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { uploadResumable } from "@/integrations/supabase/resumable-upload";

const raw = () => supabase as unknown as SupabaseClient;

export const COACH_BUCKET = "coach-videos";
/** Coach messages cap at 60s (owner spec) — ~23MB at the Dojo bitrate. */
export const COACH_MAX_SECONDS = 60;
/** Voice replies stay short — one breath, not a podcast. */
export const REPLY_MAX_SECONDS = 30;

export type CoachMessage = {
  id: string;
  sender_id: string;
  recipient_id: string;
  team_id: string | null;
  text: string | null;
  video_path: string | null;
  created_at: string;
  seen_at: string | null;
  reaction: string | null;
  reply_video_path: string | null;
};

/** The OLDEST unseen message for this user (one card per app open; the next
 *  one waits for the next open), plus the sender's first name. */
export function useUnseenCoachMessage(userId: string | undefined) {
  return useQuery({
    enabled: !!userId,
    queryKey: ["coach_messages", "unseen", userId],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<(CoachMessage & { senderName: string }) | null> => {
      const { data, error } = await raw()
        .from("coach_messages")
        .select("*")
        .eq("recipient_id", userId!)
        .is("seen_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (error) return null; // migration not applied yet — stay quiet
      const msg = (data ?? [])[0] as CoachMessage | undefined;
      if (!msg) return null;
      const { data: sender } = await supabase
        .from("profiles")
        .select("display_name")
        .eq("id", msg.sender_id)
        .maybeSingle();
      const senderName = (sender?.display_name ?? "Your coach").split(" ")[0];
      return { ...msg, senderName };
    },
  });
}

export async function signedCoachUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from(COACH_BUCKET).createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw error ?? new Error("Couldn't open the video");
  return data.signedUrl;
}

export function useMarkCoachMessage(userId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: string;
      seen?: boolean;
      reaction?: string;
      replyPath?: string;
    }) => {
      const patch: Record<string, unknown> = {};
      if (vars.seen) patch.seen_at = new Date().toISOString();
      if (vars.reaction !== undefined) patch.reaction = vars.reaction;
      if (vars.replyPath !== undefined) {
        patch.reply_video_path = vars.replyPath;
        patch.replied_at = new Date().toISOString();
      }
      const { error } = await raw().from("coach_messages").update(patch).eq("id", vars.id);
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["coach_messages", "unseen", userId] }),
  });
}

/** Upload a recorded blob into the caller's lane of coach-videos.
 *  kind "message" → messages/<uid>/… (owner/office anywhere; captains by
 *  policy), kind "reply" → replies/<uid>/… (any recipient). */
export async function uploadCoachBlob(
  kind: "message" | "reply",
  userId: string,
  blob: Blob,
  ext: string,
  onProgress?: (pct: number) => void,
): Promise<string> {
  const path = `${kind === "message" ? "messages" : "replies"}/${userId}/${crypto.randomUUID()}.${ext}`;
  await uploadResumable({
    bucket: COACH_BUCKET,
    path,
    file: blob,
    contentType: blob.type || "video/webm",
    onProgress,
  });
  return path;
}

/** Send through the RPC (crew expansion + per-recipient push server-side). */
export async function sendCoachMessage(vars: {
  recipientId?: string;
  teamId?: string;
  text?: string;
  videoPath?: string;
}): Promise<number> {
  const { data, error } = await raw().rpc("send_coach_message", {
    _recipient: vars.recipientId ?? null,
    _team: vars.teamId ?? null,
    _text: vars.text ?? null,
    _video_path: vars.videoPath ?? null,
  });
  if (error) throw error;
  return Number((data as { sent?: number } | null)?.sent ?? 1);
}
