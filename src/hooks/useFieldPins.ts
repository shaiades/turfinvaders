import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getPositionOrNull } from "@/lib/utils";
import { laTodayISO } from "@/lib/dates";
import { dailyLogKeys } from "@/hooks/useDailyLogs";
import { toast } from "sonner";
import type { FieldPin, LatLng } from "@/components/NeonMap";

/**
 * The canvass pin engine — GPS watch + every field_pins read/write the
 * Active Run screen needs, extracted from my-territory (2026-09-08 merge of
 * Active Run + Territory). Two formerly-divergent insert paths live here on
 * purpose so they can never drift again:
 *  - dropAtPoint: a map tap — pin lands where tapped, distance to the device
 *    fix is measured, >18 m flags Remote Drop (stat-dead in the bump trigger).
 *  - dropAtDevice: a tally-button tap — the pin IS the device fix, so
 *    distance_m is 0 and is_remote_drop false by construction.
 * The bump_daily_log_from_pin trigger owns all counter math; nothing in this
 * file decides what counts.
 */

export type ActivePin = FieldPin["pin_type"];

export const RESULT_TOASTS: Partial<Record<ActivePin, string>> = {
  lead: "🟢 Lead pin dropped",
  not_home: "🔴 Not home",
  go_back: "🔵 Go back — hit it again later",
  renter: "🟣 Renter logged",
  not_interested: "🟠 Not interested",
  appt: "🟡 Appt marked — counts come from Monday",
};

function haversineMeters(a: LatLng, b: LatLng) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type GeoStatus = "acquiring" | "ok" | "denied" | "unavailable";

/** One GPS watch for the whole screen (mounting it also fires the browser's
 *  permission prompt — no separate one-shot needed). */
export function useGeoWatch(): { me: LatLng | null; geoStatus: GeoStatus } {
  const [me, setMe] = useState<LatLng | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("acquiring");

  useEffect(() => {
    if (!navigator.geolocation) {
      setGeoStatus("unavailable");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoStatus("ok");
      },
      (err) => {
        console.warn("geo err", err.message);
        if (err.code === err.PERMISSION_DENIED) {
          setGeoStatus("denied");
          // Drop the stale fix too: keeping it would show "LIVE" and measure
          // every pin from wherever the rep stood when permission was revoked,
          // silently flagging real knocks as Remote Drops.
          setMe(null);
        } else {
          setGeoStatus("unavailable");
        }
      },
      { enableHighAccuracy: true, maximumAge: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  return { me, geoStatus };
}

export function useFieldPins(userId: string | undefined, me: LatLng | null) {
  const qc = useQueryClient();

  // One key per LA day: corrections are same-day by construction — after
  // midnight a still-open tab rolls to a fresh (empty) pin list instead of
  // letting yesterday's cached pins be edited. Tally-button drops invalidate
  // the ["my_pins_today", uid] prefix, which still matches this key.
  const todayISO = laTodayISO();
  const pinsKey = useMemo(() => ["my_pins_today", userId, todayISO], [userId, todayISO]);

  const pinsQuery = useQuery({
    enabled: !!userId,
    queryKey: pinsKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_pins")
        .select("id, pin_type, lat, lng, is_remote_drop, distance_m, created_at")
        .eq("canvasser_id", userId!)
        .eq("log_date", laTodayISO());
      if (error) throw error;
      return (data ?? []) as FieldPin[];
    },
  });

  const counts = useMemo(() => {
    const pins = pinsQuery.data ?? [];
    const byType: Partial<Record<ActivePin, number>> = {};
    for (const p of pins) byType[p.pin_type] = (byType[p.pin_type] ?? 0) + 1;
    return byType;
  }, [pinsQuery.data]);

  const dropAtPoint = useMutation({
    // pin_type is captured at tap time — reading the armed result in the
    // callbacks could mislabel the toast if the rep switches mid-flight.
    mutationFn: async ({ ll, pin_type }: { ll: LatLng; pin_type: ActivePin }) => {
      const fix = await getPositionOrNull({
        enableHighAccuracy: true,
        maximumAge: 10000,
        timeout: 8000,
      });
      const device = fix ? { lat: fix.coords.latitude, lng: fix.coords.longitude } : me;
      if (!device) {
        // A no-GPS pin is guaranteed stat-dead (flagged Remote, bumps nothing)
        // and sits on the rep's record forever — block it instead of inserting.
        throw new Error("No GPS fix — pin not saved. Wait for the blue dot and try again.");
      }
      const distance_m = haversineMeters(device, ll);
      const is_remote_drop = distance_m > 18;
      const { error } = await supabase.from("field_pins").insert({
        canvasser_id: userId!,
        pin_type,
        lat: ll.lat,
        lng: ll.lng,
        log_date: laTodayISO(),
        device_lat: device.lat,
        device_lng: device.lng,
        distance_m,
        is_remote_drop,
      });
      if (error) throw error;
      return { is_remote_drop, distance_m, pin_type };
    },
    // Serialize concurrent drops instead of dropping them: rapid taps on a
    // duplex both land, in order, each with its own optimistic row.
    scope: { id: "drop-pin" },
    onMutate: async ({ ll, pin_type }) => {
      // Haptic + optimistic synthetic row, so slow LTE shows the pin
      // instantly instead of inviting a second tap.
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
      // Cancel any in-flight refetch first — a response snapshotted before
      // this insert would otherwise land late and wipe the optimistic row.
      await qc.cancelQueries({ queryKey: pinsKey });
      qc.setQueryData<FieldPin[]>(pinsKey, (prev) => [
        ...(prev ?? []),
        {
          id: `optimistic-${crypto.randomUUID()}`,
          pin_type,
          lat: ll.lat,
          lng: ll.lng,
          is_remote_drop: false,
          pending: true,
        },
      ]);
    },
    onSuccess: ({ is_remote_drop, distance_m, pin_type }) => {
      if (is_remote_drop) {
        const yds = Math.round(distance_m * 1.0936);
        toast.warning(`⚠ Remote Drop flagged · ${yds} yds from pin`, {
          description: "Pin won't count toward your stats. Walk to the door and try again.",
        });
      } else {
        toast.success(RESULT_TOASTS[pin_type] ?? "Pin dropped");
      }
      // bump_daily_log_from_pin has committed by now — refresh every
      // self-scoped daily_logs read (Log form, Stats, HUD, tally counts).
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    // Refetch server truth on both outcomes — reconciles the optimistic row
    // (or removes it after an error).
    onSettled: () => qc.invalidateQueries({ queryKey: pinsKey }),
  });

  // Accidental double-taps (same spot, sub-second) are swallowed; distinct
  // taps queue via the mutation scope, so working a duplex fast loses nothing.
  const lastDropRef = useRef<{ t: number; ll: LatLng } | null>(null);

  /** The map-tap entry point: GPS guard + double-tap dedupe, then insert. */
  const guardedMapDrop = (ll: LatLng, pin_type: ActivePin) => {
    // Block BEFORE the optimistic row: a no-GPS drop would otherwise buzz,
    // show a pin for the 8 s fix wait, then silently vanish.
    if (!me) {
      toast.error("No GPS fix — pin not saved. Wait for the blue dot and try again.");
      return;
    }
    const last = lastDropRef.current;
    if (last && Date.now() - last.t < 600 && haversineMeters(last.ll, ll) < 8) return;
    lastDropRef.current = { t: Date.now(), ll };
    dropAtPoint.mutate({ ll, pin_type });
  };

  /** The tally-button entry point: the pin IS the device fix, so it can never
   *  be a remote drop. Daily-log optimism/invalidation stays with the caller
   *  (it owns the tally counters). */
  async function dropAtDevice(pin_type: ActivePin, opts?: { silent?: boolean }) {
    if (!userId) return { ok: false as const };
    const fix = await getPositionOrNull({
      enableHighAccuracy: true,
      maximumAge: 8000,
      timeout: 8000,
    });
    if (!fix) {
      toast.error("No GPS fix yet — enable Location and try again.");
      return { ok: false as const };
    }
    const { error } = await supabase.from("field_pins").insert({
      canvasser_id: userId,
      pin_type,
      lat: fix.coords.latitude,
      lng: fix.coords.longitude,
      log_date: laTodayISO(),
      device_lat: fix.coords.latitude,
      device_lng: fix.coords.longitude,
      distance_m: 0,
      is_remote_drop: false,
    });
    if (error) {
      toast.error(error.message || "Couldn't save pin");
      return { ok: false as const };
    }
    if (!opts?.silent && typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        navigator.vibrate?.(15);
      } catch {
        /* ignore */
      }
    }
    return { ok: true as const };
  }

  // Same-day corrections: switch a mis-tapped pin's result or delete it.
  // The extended bump trigger adjusts daily_logs counters on both ops.
  // Same-day is enforced in three layers: the dated pinsKey (a stale tab
  // rolls over at LA midnight), the .eq("log_date", today) guard here (a
  // stale edit no-ops), and the DB fence in 20260824150000 (RLS).
  const updatePin = useMutation({
    mutationFn: async ({ id, pin_type }: { id: string; pin_type: ActivePin }) => {
      const { error } = await supabase
        .from("field_pins")
        .update({ pin_type })
        .eq("id", id)
        .eq("log_date", laTodayISO());
      if (error) throw error;
    },
    onMutate: async ({ id, pin_type }) => {
      await qc.cancelQueries({ queryKey: pinsKey });
      qc.setQueryData<FieldPin[]>(pinsKey, (prev) =>
        (prev ?? []).map((p) => (p.id === id ? { ...p, pin_type } : p)),
      );
    },
    onSuccess: () => {
      toast.success("Pin updated — stats adjusted");
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: pinsKey }),
  });

  const deletePin = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("field_pins")
        .delete()
        .eq("id", id)
        .eq("log_date", laTodayISO());
      if (error) throw error;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: pinsKey });
      qc.setQueryData<FieldPin[]>(pinsKey, (prev) => (prev ?? []).filter((p) => p.id !== id));
    },
    onSuccess: () => {
      toast.success("Pin deleted");
      if (userId) qc.invalidateQueries({ queryKey: dailyLogKeys.all(userId) });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => qc.invalidateQueries({ queryKey: pinsKey }),
  });

  return {
    pinsKey,
    pinsQuery,
    counts,
    dropAtPoint,
    guardedMapDrop,
    dropAtDevice,
    updatePin,
    deletePin,
  };
}
