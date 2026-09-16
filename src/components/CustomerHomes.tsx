import { useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { viewBounds } from "@/lib/map-bounds";

/**
 * Tidal Remodeling customers on every canvassing map (owner ask 2026-09-14):
 * each sold job — Block cards via the customer_homes view (block_cards +
 * the pre-May-2026 legacy import) — renders as a company-logo badge on the
 * house. Tapping it shows the homeowner's LAST NAME and the product(s)
 * installed: live social proof at the door ("we did the Hagmanns' roof
 * right there"). The view exposes ONLY last name + products + coords +
 * sold date — never price, phone, reps, or the full customer name — so it
 * is safe for every authenticated role, canvassers included.
 *
 * Mounted unconditionally inside NeonMap's MapContainer, so every surface
 * (Active Run, My Territory, Crew Map, Spectate) shows customers at all
 * times. Default panes only — custom panes render displaced under
 * leaflet-rotate (see NeonMap).
 */

export type CustomerHome = {
  monday_item_id: string;
  last_name: string | null;
  products: string | null;
  lat: number;
  lng: number;
  address: string | null;
  sold_on: string | null;
};

/** One badge per HOUSE: copy-family duplicates and repeat jobs (sale +
 *  reload cards) collapse onto the same rounded coordinate, products
 *  merged. Display-only grouping — nothing here counts anything. */
type CustomerBadge = {
  key: string;
  lat: number;
  lng: number;
  last_name: string | null;
  products: string[];
  address: string | null;
  /** Newest sold_on across the house's jobs (badge popup shows one date). */
  sold_on: string | null;
};

const PAGE = 1000; // PostgREST caps un-ranged selects — page explicitly.
const PAGE_WAVE = 4; // pages fetched concurrently — ~2,800 rows land in one round trip

async function fetchCustomerHomes(): Promise<CustomerHome[]> {
  const out: CustomerHome[] = [];
  // Waves of concurrent pages instead of one-at-a-time: sequential paging
  // put 3+ mobile round trips on the map's first paint. Order is preserved
  // (each wave's results are consumed in offset order) and the first short
  // page ends the walk.
  for (let wave = 0; ; wave++) {
    const results = await Promise.all(
      Array.from({ length: PAGE_WAVE }, (_, i) => {
        const from = (wave * PAGE_WAVE + i) * PAGE;
        return supabase
          .from("customer_homes")
          .select("monday_item_id, last_name, products, lat, lng, address, sold_on")
          .order("monday_item_id")
          .range(from, from + PAGE - 1);
      }),
    );
    let done = false;
    for (const { data, error } of results) {
      if (error) throw new Error(error.message);
      for (const r of data ?? []) {
        if (typeof r.lat !== "number" || typeof r.lng !== "number" || !r.monday_item_id) continue;
        out.push({
          monday_item_id: r.monday_item_id,
          last_name: r.last_name,
          products: r.products,
          lat: r.lat,
          lng: r.lng,
          address: r.address,
          sold_on: r.sold_on,
        });
      }
      if (!data || data.length < PAGE) {
        done = true;
        break;
      }
    }
    if (done) break;
  }
  return out;
}

export function useCustomerHomes() {
  return useQuery({
    queryKey: ["customer_homes"],
    queryFn: fetchCustomerHomes,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** ~1 m rounding: the same house's cards share a Monday Location pin, so
 *  5 decimals folds copy-families without ever merging neighbors. */
function houseKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}

function groupByHouse(rows: CustomerHome[]): CustomerBadge[] {
  const byKey = new Map<string, CustomerBadge>();
  for (const r of rows) {
    const key = houseKey(r.lat, r.lng);
    const products = (r.products ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        key,
        lat: r.lat,
        lng: r.lng,
        last_name: r.last_name,
        products,
        address: r.address,
        sold_on: r.sold_on,
      });
      continue;
    }
    for (const p of products) {
      if (!prev.products.some((q) => q.toLowerCase() === p.toLowerCase())) prev.products.push(p);
    }
    prev.address ??= r.address;
    const newer = (r.sold_on ?? "") > (prev.sold_on ?? "");
    if (newer) {
      prev.sold_on = r.sold_on;
      prev.last_name = r.last_name ?? prev.last_name;
    } else {
      prev.last_name ??= r.last_name;
    }
  }
  return [...byKey.values()];
}

/** "2026-03-14" → "Mar 2026" (fixed-noon parse — no timezone day slip). */
function soldLabel(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

// Badge divIcons cached per size (NeonMap's cachedIcon rationale: stable
// identity across GPS-tick re-renders or every marker's DOM rebuilds).
// No dynamic text in the html — the logo is a static asset.
const badgeIconCache = new Map<string, L.DivIcon>();
function customerBadgeIcon(size: number, hit: number): L.DivIcon {
  const key = `${size}|${hit}`;
  let icon = badgeIconCache.get(key);
  if (!icon) {
    // The mark fills the circle (owner ask 2026-09-16 — it read tiny at
    // 0.68: the PNG also carried ~20% transparent padding, since trimmed).
    // 0.8 of the 26px badge ≈ 21px glyph inside the 23px interior (border
    // is inside via border-box) — bold, with a whisker of white left.
    // Size via INLINE STYLE, not width/height attributes: leaflet.css
    // resets img max-width/max-height (!important) and Tailwind preflight
    // sets img{height:auto}, which together beat the attributes and let
    // the PNG render at natural size — the giant glyph spilling out of the
    // badge (owner screenshot 2026-09-16). overflow:hidden is the backstop.
    const img = Math.round(size * 0.8);
    const html = `
    <div style="width:${hit}px;height:${hit}px;display:flex;align-items:center;justify-content:center;">
      <div style="width:${size}px;height:${size}px;border-radius:9999px;background:#f5f7fa;border:1.5px solid #12283a;box-shadow:0 0 6px rgba(18,40,58,0.7);display:flex;align-items:center;justify-content:center;overflow:hidden;">
        <img src="/tidal-mark.png" alt="" style="display:block;width:${img}px;height:${img}px;max-width:none;" />
      </div>
    </div>`;
    icon = L.divIcon({
      html,
      className: "tidal-customer-badge",
      iconSize: [hit, hit],
      iconAnchor: [hit / 2, hit / 2],
    });
    badgeIconCache.set(key, icon);
  }
  return icon;
}

/** Most badges the layer will mount at once — worst case a whole-county
 *  zoom-out. Same neighborhood as CrewMap's PIN_BUDGET (900) and House
 *  Bubbles' 300; trimmed from the frame edge inward so the gap reads as
 *  "off-frame", never a random hole. */
const RENDER_CAP = 350;

/** Below this zoom the DOM logo badges give way to canvas dots. Street zoom
 *  only (owner video 2026-09-15): at z13 a fixed 16px logo covered ~250 m of
 *  ground — whole blocks wore one giant badge, and a mid-zoom frame mounted
 *  up to RENDER_CAP logo divs (white circle + shadow + img each), which WAS
 *  the pan/pinch lag. Dots are canvas vectors — thousands cost nothing. */
const BADGE_MIN_ZOOM = 16;
/** Badge palette, reused by the far-zoom dots so they read as the same layer. */
const DOT_STYLE = {
  color: "#12283a",
  weight: 1.5,
  fillColor: "#f5f7fa",
  fillOpacity: 0.95,
} as const;

export function CustomerHomesLayer({ tappable = true }: { tappable?: boolean }) {
  const map = useMap();
  const { data } = useCustomerHomes();
  const [view, setView] = useState<{ bounds: L.LatLngBounds; zoom: number } | null>(null);

  useEffect(() => {
    const refresh = () => setView({ bounds: viewBounds(map), zoom: map.getZoom() });
    refresh();
    map.on("moveend", refresh);
    map.on("zoomend", refresh);
    return () => {
      map.off("moveend", refresh);
      map.off("zoomend", refresh);
    };
  }, [map]);

  const badges = useMemo(() => groupByHouse(data ?? []), [data]);

  const zoom = view?.zoom ?? 13;
  // Wide zooms draw EVERY in-frame customer as a canvas dot: the county view
  // used to trim to the 350 center-nearest DOM badges, which read as "my
  // previous sales are missing". Dots are vectors on the shared canvas
  // renderer, so thousands cost nothing and no cap is needed.
  const dotsMode = zoom < BADGE_MIN_ZOOM;

  const dotVisible = useMemo(() => {
    if (!dotsMode || !view || badges.length === 0) return [] as CustomerBadge[];
    const frame = view.bounds.pad(0.15);
    return badges.filter((b) => frame.contains([b.lat, b.lng] as [number, number]));
  }, [dotsMode, badges, view]);

  const visible = useMemo(() => {
    if (dotsMode || !view || badges.length === 0) return [] as CustomerBadge[];
    const frame = view.bounds.pad(0.15);
    const inFrame = badges.filter((b) => frame.contains([b.lat, b.lng] as [number, number]));
    if (inFrame.length <= RENDER_CAP) return inFrame;
    const c = view.bounds.getCenter();
    const cosLat = Math.cos((c.lat * Math.PI) / 180);
    const d2 = (b: CustomerBadge) => {
      const dy = b.lat - c.lat;
      const dx = (b.lng - c.lng) * cosLat;
      return dy * dy + dx * dx;
    };
    return inFrame.sort((a, b) => d2(a) - d2(b)).slice(0, RENDER_CAP);
  }, [dotsMode, badges, view]);

  if (dotsMode) {
    if (dotVisible.length === 0) return null;
    // Slightly larger through the zooms the badges used to own (13-15) so
    // the layer never reads as "sales disappeared" right below badge zoom.
    const radius = zoom >= 13 ? 5 : zoom >= 11 ? 4 : 3;
    return (
      <>
        {dotVisible.map((b) => (
          <CircleMarker
            key={b.key}
            center={[b.lat, b.lng]}
            radius={radius}
            pathOptions={DOT_STYLE}
            interactive={false}
          />
        ))}
      </>
    );
  }

  if (visible.length === 0) return null;
  // Sized to the house-bubble result circle (26px — owner 2026-09-15:
  // "replace the circle where the results go with that logo, that's the
  // size"). One size: badges exist only at street zoom now, where 26px IS
  // house-scale. The hit box stays finger-sized regardless.
  const size = 26;
  const hit = tappable ? Math.max(size, 40) : size;
  const icon = customerBadgeIcon(size, hit);

  return (
    <>
      {visible.map((b) => (
        <Marker
          key={b.key}
          position={[b.lat, b.lng]}
          icon={icon}
          interactive={tappable}
          // Below result pins and the me-dot (0) so a badge never steals the
          // tap meant for a same-door pin correction; above house bubbles
          // (-800) so the logo stays readable on bubble screens.
          zIndexOffset={-400}
        >
          {tappable && (
            <Popup className="turf-popup" minWidth={190}>
              <div className="nm-pop-title">{b.last_name ?? "Tidal customer"}</div>
              <div className="nm-pop-now">
                Tidal Remodeling customer
                {soldLabel(b.sold_on) ? (
                  <>
                    {" "}
                    · <b>{soldLabel(b.sold_on)}</b>
                  </>
                ) : null}
              </div>
              {b.products.length > 0 && (
                <div className="nm-pop-hist">
                  <div className="nm-pop-head">Work done</div>
                  <div className="nm-pop-row">
                    <span className="nm-pop-name">{b.products.join(", ")}</span>
                  </div>
                </div>
              )}
              {b.address && <div className="nm-pop-empty">{b.address}</div>}
            </Popup>
          )}
        </Marker>
      ))}
    </>
  );
}
