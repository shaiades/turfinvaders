// Crew Map live-position channel — shared constants (leaflet-free, so sheets
// and non-map surfaces can import without dragging the map into SSR; see the
// pin-results.ts convention).
//
// Transport is a PRIVATE Supabase Realtime broadcast topic. RLS on
// realtime.messages (migration 20260912210000) decides who may send (field
// tiers) and who may receive (leadership). Broadcast — not Presence — because
// the grants are asymmetric: a canvasser can publish without being able to
// read anyone else's position, which Presence's sync step doesn't allow.
// Staleness is therefore client-side: a beacon older than CREW_STALE_MS is
// pruned instead of relying on presence leave events.

export const CREW_LIVE_TOPIC = "crew-live";
export const CREW_BEACON_EVENT = "pos";

export type CrewBeacon = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Sender clock — display only. Receivers stamp their own receipt time. */
  at: number;
};

/** Re-send even when standing still, so watchers can tell "parked" from "gone". */
export const CREW_BEACON_HEARTBEAT_MS = 20_000;
/** Movement worth an early beacon (roughly a few houses). */
export const CREW_BEACON_MIN_MOVE_M = 25;
/** Floor between sends — GPS ticks arrive every few seconds while walking. */
export const CREW_BEACON_MIN_GAP_MS = 5_000;
/** Beacon older than this (receiver clock) = off the map. Six missed heartbeats. */
export const CREW_STALE_MS = 120_000;
