// Street Feed (§7) — the field's live "big moments" feed. Reads the last N
// feed_events and realtime-invalidates so a shoutout / crowning / van lead-
// change lands on every phone within a second. Writes are leaders-only (RLS);
// field reps can't post. Fails open to empty so a missing table never breaks
// the header.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type FeedEvent = {
  id: string;
  kind: string;
  actor_name: string | null;
  color: string | null;
  body: string;
  created_at: string;
};

export function useFeed(limit = 50): { events: FeedEvent[]; loading: boolean } {
  const q = useQuery({
    queryKey: ["feed_events"],
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await rawTable("feed_events")
        .select("id, kind, actor_name, color, body, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return [] as FeedEvent[];
      return (data ?? []) as unknown as FeedEvent[];
    },
  });
  // A feed INSERT re-pulls the last N (cheap, debounced) — the same realtime
  // primitive the arcade ladder uses.
  useRealtimeInvalidate({
    channel: "street-feed",
    tables: ["feed_events"],
    invalidateKeys: [["feed_events"]],
  });
  return { events: q.data ?? [], loading: q.isLoading };
}

/** Post a big moment to the feed. Leaders only (RLS enforces owner / office /
 *  captain and created_by = self). */
export async function writeFeedEvent(e: {
  kind: string;
  body: string;
  userId: string;
  actorName?: string | null;
  color?: string | null;
}): Promise<void> {
  await rawTable("feed_events").insert({
    kind: e.kind,
    body: e.body,
    actor_name: e.actorName ?? null,
    color: e.color ?? null,
    created_by: e.userId,
  });
}
