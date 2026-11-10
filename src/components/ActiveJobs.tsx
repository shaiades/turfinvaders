import { Fragment, useMemo } from "react";
import { Circle, Marker, Popup } from "react-leaflet";
import L from "leaflet";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isManagerRole } from "@/lib/role-policy";
import { haversineM } from "@/lib/house-cache";
import { laWeekStartISO } from "@/lib/dates";

/**
 * Active Tidal jobs on the canvasser map (owner ask 2026-11-04): every
 * Production-board job with Status "In Progress" shows as a small Tidal
 * badge with a soft half-mile ring — canvassers can truthfully say "We're
 * working on a home a few streets over this week," and captains run the
 * "10 doors around every active job" standard.
 *
 * PRIVACY: the data source is the active_jobs_map DEFINER view — street
 * name (house number stripped), city, projects, and coordinates rounded to
 * ~100 m. The exact address never reaches the client, so the pin marks a
 * street, never a house. Don't widen the select.
 *
 * Default panes only — custom panes render displaced under leaflet-rotate
 * (see NeonMap).
 */

export type ActiveJobSite = {
  monday_item_id: string;
  street: string | null;
  city: string | null;
  lat: number;
  lng: number;
  projects: string | null;
  office_location: string | null;
};

/** 0.5-mile ring (spec 2026-11-04) — shared by the layer, the ring-doors
 *  RPC (SQL twin in 20261104130000), and the door-pin tip. */
export const ACTIVE_JOB_RING_M = 804.67;

async function fetchActiveJobs(): Promise<ActiveJobSite[]> {
  const { data, error } = await supabase
    .from("active_jobs_map")
    .select("monday_item_id, street, city, lat, lng, projects, office_location");
  if (error) throw new Error(error.message);
  return (data ?? []).filter(
    (r): r is ActiveJobSite =>
      typeof r.lat === "number" && typeof r.lng === "number" && !!r.monday_item_id,
  );
}

export function useActiveJobs() {
  return useQuery({
    queryKey: ["active_jobs_map"],
    queryFn: fetchActiveJobs,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** The job whose ring contains `ll`, or null — nearest wins on overlap.
 *  Rings are centered on the ROUNDED coords, exactly as drawn. */
export function activeJobRingAt(
  ll: { lat: number; lng: number },
  jobs: ActiveJobSite[] | undefined,
): ActiveJobSite | null {
  let best: ActiveJobSite | null = null;
  let bestD = Infinity;
  for (const j of jobs ?? []) {
    const d = haversineM(ll.lat, ll.lng, j.lat, j.lng);
    if (d <= ACTIVE_JOB_RING_M && d < bestD) {
      best = j;
      bestD = d;
    }
  }
  return best;
}

/** Doors knocked inside each ring this week — captains/admins only (the
 *  RPC's role gate returns zero rows to everyone else, so `enabled` is a
 *  perf courtesy, not the boundary). */
export function useActiveJobRingDoors(enabled: boolean) {
  const weekStart = laWeekStartISO();
  return useQuery({
    enabled,
    queryKey: ["active_job_ring_doors", weekStart],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("active_job_ring_doors", {
        _week_start: weekStart,
      });
      if (error) throw new Error(error.message);
      const byJob = new Map<string, number>();
      for (const r of data ?? []) byJob.set(r.monday_item_id, Number(r.doors ?? 0));
      return byJob;
    },
    staleTime: 2 * 60_000,
    refetchOnWindowFocus: false,
  });
}

// Tidal-colored badge: the customer badge inverted (navy fill, white ring,
// white hammer glyph) so "we're working here" never reads as "we sold here".
// Cached like NeonMap's cachedIcon — stable identity across re-renders.
let jobIconCache: L.DivIcon | null = null;
function activeJobIcon(): L.DivIcon {
  if (!jobIconCache) {
    const size = 22;
    const hit = 40; // finger-sized tap box around the small badge
    const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="width:${size}px;height:${size}px;border-radius:9999px;background:#12283a;border:1.5px solid #f5f7fa;box-shadow:0 0 6px rgba(18,40,58,0.8);display:flex;align-items:center;justify-content:center;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f5f7fa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9"/>
          <path d="m18 15 4-4"/>
          <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5"/>
        </svg>
      </div>
    </div>`;
    jobIconCache = L.divIcon({
      html,
      className: "tidal-active-job-badge",
      iconSize: [hit, hit],
      iconAnchor: [hit / 2, hit / 2],
    });
  }
  return jobIconCache;
}

// Soft ring — accent blue at whisper opacity so satellite imagery and turf
// polygons stay readable under it; solid enough to survive sun mode.
const RING_STYLE = {
  color: "#66ccff",
  weight: 1.5,
  opacity: 0.45,
  fillColor: "#66ccff",
  fillOpacity: 0.06,
} as const;

export function ActiveJobsLayer({ enabled }: { enabled: boolean }) {
  const { role } = useAuth();
  const showDoors = isManagerRole(role);
  const { data: jobs } = useActiveJobs();
  const doors = useActiveJobRingDoors(enabled && showDoors);

  const sites = useMemo(() => jobs ?? [], [jobs]);
  if (!enabled || sites.length === 0) return null;
  const icon = activeJobIcon();

  return (
    <>
      {sites.map((j) => {
        const where = [j.street, j.city].filter(Boolean).join(", ");
        const count = showDoors ? (doors.data?.get(j.monday_item_id) ?? 0) : null;
        return (
          <Fragment key={j.monday_item_id}>
            <Circle
              center={[j.lat, j.lng]}
              radius={ACTIVE_JOB_RING_M}
              pathOptions={RING_STYLE}
              interactive={false}
            />
            <Marker
              position={[j.lat, j.lng]}
              icon={icon}
              // Below result pins and customer badges (-400) so a job badge
              // never steals a same-door correction tap; above house
              // bubbles (-800).
              zIndexOffset={-600}
            >
              <Popup className="turf-popup" minWidth={190}>
                <div className="nm-pop-title">{j.street ?? "Tidal job site"}</div>
                <div className="nm-pop-now">Active this week{j.city ? <> · {j.city}</> : null}</div>
                {j.projects && (
                  <div className="nm-pop-hist">
                    <div className="nm-pop-head">Working on</div>
                    <div className="nm-pop-row">
                      <span className="nm-pop-name">{j.projects}</span>
                    </div>
                  </div>
                )}
                {count !== null && (
                  <div className="nm-pop-empty">
                    {count} door{count === 1 ? "" : "s"} knocked in this ring this week
                  </div>
                )}
                {!showDoors && where !== "" && (
                  <div className="nm-pop-empty">Knock the 10 doors around it</div>
                )}
              </Popup>
            </Marker>
          </Fragment>
        );
      })}
    </>
  );
}
