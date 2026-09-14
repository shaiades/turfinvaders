import { useEffect, useState } from "react";
import { GEO_GRANTED_EVENT, GEO_GRANTED_KEY } from "@/hooks/useFieldPins";

/** True once the OS geolocation permission is ALREADY granted — determined
 *  without ever prompting. Primary source: the Permissions API, kept live
 *  via its change event (covers grant AND later revocation). Fallback for
 *  browsers without it: the marker useGeoWatch writes on its first fix,
 *  plus the same-session GEO_GRANTED_EVENT. Consumers use this to run
 *  background GPS work (the crew beacon) only after a map screen earned
 *  the prompt — the canvass screen keeps owning the first ask. */
export function useGeoGranted(): boolean {
  const [granted, setGranted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const readMarker = () => {
      try {
        return localStorage.getItem(GEO_GRANTED_KEY) === "1";
      } catch {
        return false;
      }
    };
    const onChange = () => {
      if (status && !cancelled) setGranted(status.state === "granted");
    };
    const onGrantEvent = () => {
      if (!cancelled) setGranted(true);
    };
    if (typeof navigator !== "undefined" && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((s) => {
          if (cancelled) return;
          status = s;
          setGranted(s.state === "granted");
          s.addEventListener("change", onChange);
        })
        .catch(() => {
          if (!cancelled) setGranted(readMarker());
        });
    } else {
      setGranted(readMarker());
    }
    window.addEventListener(GEO_GRANTED_EVENT, onGrantEvent);
    return () => {
      cancelled = true;
      status?.removeEventListener("change", onChange);
      window.removeEventListener(GEO_GRANTED_EVENT, onGrantEvent);
    };
  }, []);

  return granted;
}
