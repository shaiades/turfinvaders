import { useQuery } from "@tanstack/react-query";
import { withTimeout } from "@/lib/abort-timeout";

/**
 * ONE Nominatim reverse lookup per house per session — shared by every
 * surface that resolves a house's address (HouseResultSheet, the
 * hold-for-address popup). The queryKey is the house id, which is
 * coordinate-stable even for synthetic point-houses, so staleTime:Infinity
 * makes the session cache the dedupe. Nominatim's usage policy is the hard
 * budget here: never refetch, never retry, 6s timeout so a dead-zone rep
 * isn't left hanging.
 *
 * Trust tiers (callers must keep them honest):
 *  - OSM num + street on the house itself: exact.
 *  - OSM num + this hook's road: the number is OSM truth, the road is
 *    near-certain at parcel distance — safe to show plain.
 *  - this hook's house number (hn): INTERPOLATED, can be the neighbor's —
 *    display with a ≈ and never pass onward as fact.
 */
export function useReverseGeocode(
  house: { id: string; lat: number; lng: number } | null,
  enabled: boolean,
) {
  return useQuery({
    enabled: enabled && !!house,
    queryKey: ["rev_geocode", house?.id],
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${house!.lat}&lon=${house!.lng}&zoom=18&addressdetails=1`,
        { signal: withTimeout(signal, 6_000), headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`nominatim ${res.status}`);
      const data = (await res.json()) as { address?: Record<string, string> };
      const a = data.address ?? {};
      return {
        hn: a.house_number ?? "",
        road: a.road ?? a.pedestrian ?? a.residential ?? "",
        postcode: a.postcode ?? "",
        city: a.city ?? a.town ?? a.village ?? a.hamlet ?? "",
      };
    },
  });
}
