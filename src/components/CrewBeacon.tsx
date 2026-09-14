import { useAuth } from "@/hooks/useAuth";
import { useGeoGranted } from "@/hooks/useGeoGranted";
import { useGeoWatch } from "@/hooks/useFieldPins";
import { useCrewBeacon } from "@/hooks/useCrewLive";
import { useOpenShift } from "@/hooks/useTimeClockSelf";

/** App-wide crew-live publisher (owner ask 2026-09-14: leadership sees
 *  everyone's live activity at any given time). Rides AppShell so a rep
 *  checking Mission/Learn/Leaders/Wrap — or a captain watching the Crew
 *  Map — keeps broadcasting; before, the beacon lived on ActiveRun only
 *  and every other tab went dark within 120s.
 *
 *  Three arm conditions, all required:
 *  - REAL role in the crew-live INSERT policy set (canvasser/confirmer/
 *    captain) — a View-As preview neither opens a GPS watch nor fires
 *    refused sends.
 *  - OS geolocation permission ALREADY granted (useGeoGranted never
 *    prompts) — the canvass screen behind the Gratitude Gate still owns
 *    the first prompt, exactly as staged since the go-live audit.
 *  - ON THE CLOCK (owner decision 2026-09-14: clocked-in only, matching
 *    how clock-in gates dispatch and map standings) — off the clock a
 *    rep's app never broadcasts, so an evening at home puts no dot on the
 *    leadership map. Punch state fails CLOSED here (unknown = silent),
 *    the inverse of the HUD's fail-open alarm; same-device punches flip
 *    it instantly via the shared ["time-clock-open"] key, and a 5-min
 *    poll catches a manager's remote clock-out. */
const PUBLISHER_ROLES: readonly string[] = ["canvasser", "confirmer", "captain"];

export function CrewBeacon() {
  const { user, realRole, displayName, loading } = useAuth();
  const granted = useGeoGranted();
  const publisher = !loading && !!user?.id && !!realRole && PUBLISHER_ROLES.includes(realRole);
  const openShift = useOpenShift(user?.id ?? "", {
    enabled: publisher,
    refetchInterval: 5 * 60_000,
  });
  const enabled = publisher && granted && !!openShift.data;
  const { me } = useGeoWatch(enabled);
  useCrewBeacon({ userId: user?.id, name: displayName, me, enabled });
  return null;
}
