// Hold-for-address (owner ask 2026-10-16, Apple/Google Maps parity): press
// and hold any house on the canvass map → a dropped pin plus this popup with
// the address and a one-tap copy, so a rep never has to find the same roof
// again in a separate maps app. Address resolution mirrors HouseResultSheet's
// trust tiers (OSM exact / reverse-geocoded ≈ approx) via the shared
// useReverseGeocode hook — same session cache, one Nominatim call per house.

import L from "leaflet";
import { Marker, Popup } from "react-leaflet";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { OsmHouse } from "@/lib/house-cache";
import { useReverseGeocode } from "@/hooks/useReverseGeocode";

// Apple-style dropped pin. Stateless descriptor, module-shared (NeonMap's
// iconCache precedent); tip anchored on the held house's center.
const HELD_PIN = L.divIcon({
  html: `
  <svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">
    <path d="M15 1.5 C7.5 1.5 2 7.2 2 14.5 C2 23.5 15 40.5 15 40.5 C15 40.5 28 23.5 28 14.5 C28 7.2 22.5 1.5 15 1.5 Z"
      fill="#ff2d55" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="15" cy="14.5" r="4.5" fill="#ffffff"/>
  </svg>`,
  className: "neon-held-pin",
  iconSize: [30, 42],
  iconAnchor: [15, 40],
});

// ActiveRun's lead-header copy pattern: clipboard API or an honest failure —
// no execCommand fallback theater on a stack that only ships over https.
function copyText(text: string, what: string) {
  const cb = navigator.clipboard;
  if (!cb) {
    toast.error("Couldn't copy on this device");
    return;
  }
  cb.writeText(text).then(
    () => toast.success(`${what} copied — paste it anywhere`),
    () => toast.error("Couldn't copy on this device"),
  );
}

function AddressContent({ house }: { house: OsmHouse }) {
  // Geocode whenever any display piece (street, zip, city) is missing — an
  // OSM-exact house still wants its "San Diego 92117" second line.
  const needsGeocode = !(house.num && house.street && house.zip);
  const rev = useReverseGeocode(house, needsGeocode);
  const road = house.street || rev.data?.road || "";
  const zip = house.zip || rev.data?.postcode || "";
  const city = rev.data?.city || "";
  const exactAddr = house.num && road ? `${house.num} ${road}` : null;
  const approxAddr =
    !house.num && (rev.data?.hn || rev.data?.road)
      ? [rev.data?.hn, rev.data?.road].filter(Boolean).join(" ")
      : null;
  const line1 = exactAddr ?? approxAddr;
  const line2 = [city, zip].filter(Boolean).join(" ");
  const full = line1 ? [line1, line2].filter(Boolean).join(", ") : "";
  const coords = `${house.lat.toFixed(6)}, ${house.lng.toFixed(6)}`;
  const finding = !line1 && needsGeocode && rev.isLoading;

  return (
    <div>
      <div className="nm-pop-title">
        {line1 ? (exactAddr ? line1 : `≈ ${line1}`) : finding ? "Finding address…" : "This house"}
      </div>
      {line2 && <div className="nm-pop-now">{line2}</div>}
      {!line1 && !finding && (
        <div className="nm-pop-empty">No address found here — copy the coordinates instead.</div>
      )}
      {!exactAddr && approxAddr && (
        <div className="nm-pop-empty">Approximate — double-check the number at the door.</div>
      )}
      <button
        type="button"
        className="nm-pop-btn"
        disabled={!full}
        onClick={() => copyText(full, "Address")}
      >
        Copy address
      </button>
      <button
        type="button"
        className="nm-pop-coords"
        aria-label={`Copy coordinates ${coords}`}
        onClick={() => copyText(coords, "Coordinates")}
      >
        <Copy aria-hidden style={{ width: 12, height: 12, flexShrink: 0 }} />
        {coords}
      </button>
    </div>
  );
}

export function HouseAddressPopup({
  house,
  onClosed,
}: {
  house: OsmHouse;
  /** Leaflet removed the popup (its ✕, a map tap, a new hold replacing it) —
   *  the id lets the owner ignore stale removes from a superseded popup. */
  onClosed: (id: string) => void;
}) {
  return (
    <>
      <Marker position={house.pos} icon={HELD_PIN} interactive={false} zIndexOffset={1200} />
      <Popup
        position={house.pos}
        offset={[0, -44]}
        minWidth={200}
        maxWidth={260}
        className="turf-popup addr-popup"
        eventHandlers={{ remove: () => onClosed(house.id) }}
      >
        <AddressContent house={house} />
      </Popup>
    </>
  );
}
