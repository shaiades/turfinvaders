import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { laTodayISO } from "@/lib/dates";
import type { PinType } from "@/lib/pin-results";
import {
  CREW_BEACON_EVENT,
  CREW_BEACON_HEARTBEAT_MS,
  CREW_BEACON_MIN_GAP_MS,
  CREW_BEACON_MIN_MOVE_M,
  CREW_LIVE_TOPIC,
  CREW_STALE_MS,
  type CrewBeacon,
} from "@/lib/crew-live";

type LatLng = { lat: number; lng: number };

function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Publisher half of the Crew Map: rides Active Run's existing GPS watch (never
 * opens its own — the OS prompt ordering behind the Gratitude Gate is
 * load-bearing) and posts a throttled position beacon to the private
 * crew-live topic.
 *
 * Delivery is REST (`channel.httpSend`), NOT a websocket join: Realtime
 * authorizes a private-channel JOIN against the SELECT policies only, and
 * field reps deliberately hold just INSERT (a read grant would leak every
 * rep's live position to all canvassers). httpSend checks the write policy
 * per message, which is exactly the grant they have — and skipping the join
 * also skips the endless rejoin retries an unauthorized subscribe schedules.
 *
 * Fire-and-forget by design: a refused send (role without the grant,
 * policies missing, offline) must never surface on the run screen.
 */
export function useCrewBeacon({
  userId,
  name,
  me,
  enabled,
}: {
  userId: string | undefined;
  name: string | null;
  me: LatLng | null;
  enabled: boolean;
}) {
  const lastSentRef = useRef<{ lat: number; lng: number; at: number } | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  const nameRef = useRef(name);
  nameRef.current = name;

  useEffect(() => {
    if (!enabled || !userId) return;

    // httpSend signs with the realtime socket's cached token; prime it from
    // the auth session (public API — the automatic SIGNED_IN/TOKEN_REFRESHED
    // wiring keeps it fresh afterwards). A not-yet-primed first send just
    // fails quietly and the next interval tick retries.
    void supabase.realtime.setAuth().catch(() => {});

    // Registers the channel locally; no subscribe() on purpose (see above).
    const ch = supabase.channel(CREW_LIVE_TOPIC, {
      config: { private: true, broadcast: { self: false, ack: false } },
    });

    const maybeSend = () => {
      const pos = meRef.current;
      if (!pos) return;
      const now = Date.now();
      const last = lastSentRef.current;
      const since = last ? now - last.at : Infinity;
      const moved = last ? haversineMeters(last, pos) : Infinity;
      const due =
        since >= CREW_BEACON_HEARTBEAT_MS ||
        (moved >= CREW_BEACON_MIN_MOVE_M && since >= CREW_BEACON_MIN_GAP_MS);
      if (!due) return;
      lastSentRef.current = { lat: pos.lat, lng: pos.lng, at: now };
      const payload: CrewBeacon = {
        id: userId,
        name: nameRef.current ?? "Player",
        lat: pos.lat,
        lng: pos.lng,
        at: now,
      };
      void ch.httpSend(CREW_BEACON_EVENT, payload).catch(() => {
        /* best-effort — retried by the next interval tick */
      });
    };

    // Interval, not a per-tick effect: watchPosition can go quiet while the
    // rep stands on a porch, and the heartbeat is what tells the map
    // "still here" vs "phone died".
    const timer = setInterval(maybeSend, CREW_BEACON_MIN_GAP_MS);
    maybeSend();

    return () => {
      clearInterval(timer);
      supabase.removeChannel(ch);
    };
  }, [enabled, userId]);
}

export type CrewLiveStatus = "connecting" | "live" | "unavailable";

/**
 * Watcher half: leadership joins the topic read-only (their SELECT policy
 * authorizes the websocket join) and keeps a userId → freshest beacon map.
 *
 * Beacons are stamped with the RECEIVER's clock (a field phone's clock can be
 * minutes off) and pruned after CREW_STALE_MS. Incoming messages coalesce in
 * a ref and flush to state every couple of seconds — 20 reps beaconing on
 * independent timers must not mean a full map re-render per message.
 * "unavailable" (join refused / socket down) must degrade to a pins-only
 * map, never an error state.
 */
export function useCrewLive(enabled: boolean) {
  const [positions, setPositions] = useState<Record<string, CrewBeacon>>({});
  const [status, setStatus] = useState<CrewLiveStatus>("connecting");

  useEffect(() => {
    if (!enabled) return;
    setPositions({});
    setStatus("connecting");

    const pending = new Map<string, CrewBeacon>();
    const ch = supabase.channel(CREW_LIVE_TOPIC, {
      config: { private: true, broadcast: { self: false, ack: false } },
    });
    ch.on("broadcast", { event: CREW_BEACON_EVENT }, ({ payload }) => {
      const b = payload as Partial<CrewBeacon> | undefined;
      if (
        !b ||
        typeof b.id !== "string" ||
        typeof b.name !== "string" ||
        typeof b.lat !== "number" ||
        typeof b.lng !== "number" ||
        !Number.isFinite(b.lat) ||
        !Number.isFinite(b.lng)
      )
        return;
      pending.set(b.id, {
        id: b.id,
        name: b.name.slice(0, 80),
        lat: b.lat,
        lng: b.lng,
        at: Date.now(),
      });
    });
    ch.subscribe((s) => {
      if (s === "SUBSCRIBED") setStatus("live");
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED")
        setStatus("unavailable");
    });

    // One timer does both: flush the coalesced batch and prune stale entries.
    const tick = setInterval(() => {
      const now = Date.now();
      setPositions((prev) => {
        let changed = false;
        const next: Record<string, CrewBeacon> = {};
        for (const [id, b] of Object.entries(prev)) {
          if (now - b.at <= CREW_STALE_MS) next[id] = b;
          else changed = true;
        }
        if (pending.size > 0) {
          for (const [id, b] of pending) next[id] = b;
          pending.clear();
          changed = true;
        }
        return changed ? next : prev;
      });
    }, 2_000);

    return () => {
      clearInterval(tick);
      supabase.removeChannel(ch);
    };
  }, [enabled]);

  return { positions, status };
}

export type CrewPinRow = {
  id: string;
  canvasser_id: string;
  pin_type: PinType;
  lat: number;
  lng: number;
  is_remote_drop: boolean;
  created_at: string;
};

/**
 * Every crew pin for the current LA day. Client-side read — the captain /
 * owner / office_staff view-all SELECT policies on field_pins are the gate
 * (a canvasser running this would silently get only their own rows).
 *
 * Paged because PostgREST truncates at 1000 rows WITHOUT an error and a busy
 * Saturday clears that fleet-wide (the PR #161 lesson). Ordered by
 * (created_at, id) and deduped by id: field_pins.id is a random uuid, so
 * offset pages over a live-inserting table can re-read a boundary row.
 *
 * Poll-only, DELIBERATELY no realtime invalidation: the fleet drops a pin
 * every few seconds on a good day, and even the debounced invalidate would
 * re-download the whole day near-continuously (the PR #140 storm shape).
 * The live layer is the beacons; 30s-fresh pins are plenty for an overview.
 */
export function useCrewPins(enabled: boolean) {
  const today = laTodayISO();
  return useQuery({
    enabled,
    queryKey: ["crew_pins", today],
    refetchInterval: enabled ? 30_000 : false,
    queryFn: async ({ signal }) => {
      const PAGE = 1000;
      const byId = new Map<string, CrewPinRow>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase
          .from("field_pins")
          .select("id, canvasser_id, pin_type, lat, lng, is_remote_drop, created_at")
          .eq("log_date", today)
          .order("created_at")
          .order("id")
          .range(from, from + PAGE - 1)
          .abortSignal(signal);
        if (error) throw error;
        const page = (data ?? []) as CrewPinRow[];
        for (const row of page) byId.set(row.id, row);
        if (page.length < PAGE) break;
      }
      return [...byId.values()];
    },
  });
}
