import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isAdminRole } from "@/lib/role-policy";
import { laTodayISO } from "@/lib/dates";
import { getPositionOrNull } from "@/lib/utils";
import { withTimeout } from "@/lib/abort-timeout";
import { useRealtimeInvalidate } from "@/hooks/useRealtimeInvalidate";

/**
 * "Still in house" pings — the rep's can't-make-my-lead button. The mutation
 * REQUIRES a live GPS fix (no fix → it throws, nothing is logged): the ping's
 * value is proving where the rep actually is, so a location-less ping would
 * defeat its purpose. Reverse geocode is best-effort Nominatim (same budget
 * discipline as useReverseGeocode: one shot, no retry, short timeout) — the
 * coordinates are the evidence, the address is the convenience.
 */

const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export type InHousePing = {
  id: string;
  rep_id: string;
  rep_name: string | null;
  monday_item_id: string;
  lead_name: string | null;
  lead_address: string | null;
  lat: number;
  lng: number;
  accuracy_m: number | null;
  located_address: string | null;
  note: string | null;
  ping_date: string;
  status: "open" | "handled";
  handled_by: string | null;
  handled_at: string | null;
  created_at: string;
};

/** One-shot Nominatim reverse lookup; null on any failure (dead zone, 429…). */
async function reverseGeocodeOrNull(lat: number, lng: number): Promise<string | null> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
      { signal: withTimeout(undefined, 6_000), headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { address?: Record<string, string> };
    const a = data.address ?? {};
    const street = [a.house_number, a.road ?? a.pedestrian ?? a.residential]
      .filter(Boolean)
      .join(" ");
    const city = a.city ?? a.town ?? a.village ?? a.hamlet ?? "";
    const parts = [street, city, a.postcode].filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  } catch {
    return null;
  }
}

export class LocationRequiredError extends Error {
  constructor() {
    super("Location required");
    this.name = "LocationRequiredError";
  }
}

export function useReportStillInHouse() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (input: {
      mondayItemId: string;
      leadName: string | null;
      leadAddress: string | null;
      repName: string | null;
      note: string;
    }): Promise<InHousePing> => {
      if (!user?.id) throw new Error("Not signed in");
      // Fresh, high-accuracy fix only — a cached position from an hour ago
      // would let the ping lie. 30s staleness is the ceiling.
      const pos = await getPositionOrNull({
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 30_000,
      });
      if (!pos) throw new LocationRequiredError();
      const { latitude, longitude, accuracy } = pos.coords;
      const located = await reverseGeocodeOrNull(latitude, longitude);
      const { data, error } = await rawTable("in_house_pings")
        .insert({
          rep_id: user.id,
          rep_name: input.repName,
          monday_item_id: input.mondayItemId,
          lead_name: input.leadName,
          lead_address: input.leadAddress,
          lat: latitude,
          lng: longitude,
          accuracy_m: Number.isFinite(accuracy) ? accuracy : null,
          located_address: located,
          note: input.note.trim() || null,
        })
        .select("*")
        .single();
      if (error) throw error;
      return data as InHousePing;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["in_house_pings"] });
    },
  });
}

/** The rep's own pings for today, newest first — marks their cards as flagged. */
export function useMyInHousePingsToday(enabled = true) {
  const { user } = useAuth();
  const today = laTodayISO();
  return useQuery({
    enabled: enabled && !!user?.id,
    queryKey: ["in_house_pings", "mine", user?.id, today],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("in_house_pings")
        .select("*")
        .eq("rep_id", user!.id)
        .eq("ping_date", today)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return [] as InHousePing[];
      return (data ?? []) as InHousePing[];
    },
  });
}

/** Dispatch view: today's pings (open first handled in the panel). Admin tier
 *  only; realtime so a ping pops on Fleet Dispatch within a second. */
export function useInHousePingsToday() {
  const { realRole } = useAuth();
  const enabled = isAdminRole(realRole);
  const today = laTodayISO();
  useRealtimeInvalidate({
    channel: "in-house-pings-live",
    tables: ["in_house_pings"],
    invalidateKeys: [["in_house_pings"]],
    enabled,
  });
  return useQuery({
    enabled,
    queryKey: ["in_house_pings", "today", today],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rawTable("in_house_pings")
        .select("*")
        .eq("ping_date", today)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) return [] as InHousePing[];
      return (data ?? []) as InHousePing[];
    },
  });
}

export function useMarkInHousePingHandled() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (pingId: string) => {
      const { error } = await rawTable("in_house_pings")
        .update({
          status: "handled",
          handled_by: user?.id ?? null,
          handled_at: new Date().toISOString(),
        })
        .eq("id", pingId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["in_house_pings"] });
    },
  });
}
