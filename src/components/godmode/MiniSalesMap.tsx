// God Mode "where the month sold" mini-map (owner, 2026-10-01). Deliberately
// NOT NeonMap: a static-feel, interaction-disabled Leaflet with this month's
// sold pins only. Lazy-loaded (React.lazy in GodMode) so the Leaflet chunk
// and Esri tiles never ship unless the owner taps "show map".

import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { MapContainer, Marker, TileLayer } from "react-leaflet";
import L from "leaflet";
import { NeonButton } from "@/components/arcade";

export type SoldPin = {
  monday_item_id: string;
  lat: number;
  lng: number;
  office_location: string | null;
};

const PIN_CACHE = new Map<string, L.DivIcon>();
function pinIcon(office: string | null): L.DivIcon {
  const key = office ?? "x";
  let icon = PIN_CACHE.get(key);
  if (!icon) {
    const color = office === "Orange County" ? "var(--neon)" : "var(--turf-cyan)";
    icon = L.divIcon({
      className: "",
      iconSize: [10, 10],
      iconAnchor: [5, 5],
      html: `<div style="width:10px;height:10px;border-radius:9999px;background:${color};border:2px solid var(--background);box-shadow:0 0 6px ${color}"></div>`,
    });
    PIN_CACHE.set(key, icon);
  }
  return icon;
}

export default function MiniSalesMap({ pins }: { pins: SoldPin[] }) {
  const bounds = useMemo(() => {
    const b = L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
    return b.isValid() ? b.pad(0.15) : null;
  }, [pins]);
  if (!bounds) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No mapped sales this month — cards need a Location pin on Monday.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="relative h-[220px] overflow-hidden rounded-lg border border-border min-w-0">
        <MapContainer
          bounds={bounds}
          boundsOptions={{ maxZoom: 11 }}
          dragging={false}
          touchZoom={false}
          scrollWheelZoom={false}
          doubleClickZoom={false}
          keyboard={false}
          zoomControl={false}
          attributionControl
          className="h-full w-full"
        >
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="&copy; Esri"
          />
          {pins.map((p) => (
            <Marker
              key={p.monday_item_id}
              position={[p.lat, p.lng]}
              icon={pinIcon(p.office_location)}
              interactive={false}
            />
          ))}
        </MapContainer>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted-foreground">
          <span className="text-turf-cyan">●</span> San Diego · <span className="text-neon">●</span>{" "}
          Orange County
        </span>
        <NeonButton asChild className="min-h-9">
          <Link to="/field">Open territory map</Link>
        </NeonButton>
      </div>
    </div>
  );
}
