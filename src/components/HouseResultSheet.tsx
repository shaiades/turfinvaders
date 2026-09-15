// One-tap knock logging for a house bubble (owner ask 2026-09-10, D2DU-video
// parity): tap the house on the map, tap the result — that's the whole knock.
// A house that already has a result today opens in switch mode (corrections
// adjust stats via the bump trigger); "Knocked again" arms a fresh drop for
// genuine re-knocks so a second visit counts a second door.
// 2026-09-15 (rep feedback via owner): the title is the ADDRESS where OSM
// knows it, and the sheet carries House Notes — team-visible, tied to the
// spot, stat-dead by construction (their own table, no bump trigger).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, StickyNote, X } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { withTimeout } from "@/lib/abort-timeout";
import { PIN_LABELS, type PinType } from "@/lib/pin-results";
import { haversineM, MATCH_METERS, type OsmHouse } from "@/lib/house-cache";

// Untyped table access (ObjectionDojo/gratitude pattern) until generated
// types catch up with house_notes — the default SupabaseClient generics
// keep the builder loose without per-call-site casts.
const rawTable = (name: string) => (supabase as unknown as SupabaseClient).from(name);

export function HouseResultSheet({
  open,
  onOpenChange,
  house,
  results,
  busy,
  onDrop,
  onSwitch,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  house: OsmHouse | null;
  /** The knock-result vocabulary (the page's KNOCK_RESULTS list). */
  results: Array<{ type: PinType; label: string; color: string; icon: React.ReactNode }>;
  busy: boolean;
  /** Log a fresh knock on this house with the tapped result. */
  onDrop: (house: OsmHouse, pin_type: PinType) => void;
  /** Correct today's existing result on this house. */
  onSwitch: (pinId: string, pin_type: PinType) => void;
}) {
  // Latched copy (PinActionSheet pattern): the parent clears the house while
  // the close animation plays — rendering from `view` keeps it from emptying.
  const [view, setView] = useState<OsmHouse | null>(house);
  // Switch mode is the default when today already logged this house;
  // "Knocked again" flips one interaction to drop mode.
  const [again, setAgain] = useState(false);

  useEffect(() => {
    if (open) {
      setView(house);
      setAgain(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, house?.id]);

  const hasCurrent = !!view?.currentPinId && !again;

  // The address is the title (owner emphasis 2026-09-15: "address more than
  // homeowner name" — names are licensed data this stack doesn't have).
  // OSM addr tags first; where they're missing, ONE Nominatim reverse lookup
  // per house per session fills the gap. Trust tiers keep it honest:
  //  - OSM num + street: exact.
  //  - OSM num + reverse-geocoded road: the number is OSM truth, the road is
  //    near-certain at parcel distance — still shown plain.
  //  - reverse-geocoded number: interpolated, can be the neighbor's — shown
  //    with a ≈ and NEVER passed onward into the lead form.
  const needsGeocode = open && !!view && !(view.num && view.street);
  const revQuery = useQuery({
    enabled: needsGeocode,
    queryKey: ["rev_geocode", view?.id],
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: false,
    queryFn: async ({ signal }) => {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${view!.lat}&lon=${view!.lng}&zoom=18&addressdetails=1`,
        { signal: withTimeout(signal, 6_000), headers: { Accept: "application/json" } },
      );
      if (!res.ok) throw new Error(`nominatim ${res.status}`);
      const data = (await res.json()) as { address?: Record<string, string> };
      const a = data.address ?? {};
      return {
        hn: a.house_number ?? "",
        road: a.road ?? a.pedestrian ?? a.residential ?? "",
      };
    },
  });
  const road = view?.street || revQuery.data?.road || "";
  // Exact-grade address: OSM housenumber + a street from either source.
  const exactAddr = view?.num && road ? `${view.num} ${road}` : null;
  const approxAddr =
    !view?.num && (revQuery.data?.hn || revQuery.data?.road)
      ? `≈ ${[revQuery.data?.hn, revQuery.data?.road].filter(Boolean).join(" ")}`
      : null;
  const title = exactAddr ?? (view?.num ? `House ${view.num}` : (approxAddr ?? "This house"));

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        if (!busy) onOpenChange(v);
      }}
    >
      <SheetContent aria-describedby={undefined}>
        <SheetHeader>
          <SheetTitle className="font-display text-neon text-base uppercase tracking-widest">
            {title}
          </SheetTitle>
          <SheetDescription>
            {hasCurrent && view?.currentType
              ? `Today: ${PIN_LABELS[view.currentType]} — tap a result to switch it (stats adjust)`
              : "Tap what happened at this door — one tap logs the knock and the result."}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-3 overflow-y-auto px-4 pt-3 pb-4">
          <div className="grid grid-cols-3 gap-2" data-tour="house-results">
            {results.map((r) => {
              const current = hasCurrent && view?.currentType === r.type;
              return (
                <button
                  key={r.type}
                  type="button"
                  disabled={busy || current}
                  onClick={() => {
                    if (!view) return;
                    if (hasCurrent && view.currentPinId) {
                      onSwitch(view.currentPinId, r.type);
                    } else {
                      // Ride the resolved street along (the Lead flow shows
                      // the address while the rep fills the form) — never
                      // the reverse-geocoded house NUMBER, which can be
                      // interpolated onto the neighbor.
                      onDrop(road && !view.street ? { ...view, street: road } : view, r.type);
                    }
                    onOpenChange(false);
                  }}
                  className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border p-2 ${busy ? "opacity-60" : ""}`}
                  style={{
                    color: r.color,
                    borderColor: current ? r.color : "var(--border)",
                    background: current
                      ? `color-mix(in oklab, ${r.color} 14%, var(--surface))`
                      : "var(--surface)",
                    boxShadow: current ? `0 0 14px -4px ${r.color}` : "none",
                  }}
                >
                  {r.icon}
                  <span className="font-display text-[9px] uppercase tracking-widest">
                    {r.label}
                  </span>
                  {current && (
                    <span className="text-[8px] uppercase tracking-widest text-muted-foreground">
                      Current
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {!!view?.currentPinId && !again && (
            <Button
              variant="outline"
              className="w-full gap-2"
              disabled={busy}
              onClick={() => setAgain(true)}
            >
              <RotateCcw className="w-4 h-4" />
              Knocked again — log a new result
            </Button>
          )}
          {again && (
            <div className="text-xs text-muted-foreground text-center">
              Next tap logs a fresh knock on this house.
            </div>
          )}

          {view && <HouseNotes house={view} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

type NoteRow = {
  id: string;
  author_id: string;
  lat: number;
  lng: number;
  note: string;
  created_at: string;
};

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(iso).toLocaleDateString();
}

/** Notes pinned to this house (rep ask 2026-09-15: "put notes at the house").
 *  Team knowledge: every signed-in rep reads them — gate codes, "dog in
 *  yard", "come back at 6" help whoever works the turf next. Fetched by a
 *  ±MATCH_METERS box around the bubble center (the same radius that ties
 *  pins and the 📝 badge to a house), exact-filtered by distance so a
 *  zero-lot neighbor's note doesn't bleed in. Saving a note never logs a
 *  knock — separate table, no bump trigger, stat-dead by construction. */
function HouseNotes({ house }: { house: OsmHouse }) {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const dLat = MATCH_METERS / 111_000;
  const dLng = MATCH_METERS / (111_000 * Math.cos((house.lat * Math.PI) / 180));
  const notesQuery = useQuery({
    queryKey: ["house_notes", "house", house.id, house.lat, house.lng],
    queryFn: async () => {
      const { data, error } = await rawTable("house_notes")
        .select("id, author_id, lat, lng, note, created_at")
        .gte("lat", house.lat - dLat)
        .lte("lat", house.lat + dLat)
        .gte("lng", house.lng - dLng)
        .lte("lng", house.lng + dLng)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      const rows = ((data ?? []) as NoteRow[]).filter(
        (r) => haversineM(house.lat, house.lng, r.lat, r.lng) <= MATCH_METERS,
      );
      if (rows.length === 0) return [] as Array<NoteRow & { name: string }>;
      // Author first names via a second read (GratitudeWall pattern — no FK
      // embeds on an untyped table).
      const ids = [...new Set(rows.map((r) => r.author_id))];
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      const names = new Map((profs ?? []).map((p) => [p.id, p.display_name ?? ""]));
      return rows.map((r) => ({
        ...r,
        name: (names.get(r.author_id) ?? "").split(" ")[0] || "Teammate",
      }));
    },
  });

  const addNote = useMutation({
    mutationFn: async () => {
      const text = draft.trim().slice(0, 500);
      if (!text || !user) return;
      const { error } = await rawTable("house_notes").insert({
        author_id: user.id,
        lat: house.lat,
        lng: house.lng,
        note: text,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setDraft("");
      // One prefix refreshes this list AND the map's 📝 badges.
      qc.invalidateQueries({ queryKey: ["house_notes"] });
    },
    onError: (e: Error) => toast.error(e.message || "Couldn't save the note"),
  });

  const deleteNote = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rawTable("house_notes").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["house_notes"] }),
    onError: (e: Error) => toast.error(e.message || "Couldn't delete the note"),
  });

  const notes = notesQuery.data ?? [];
  const canModerate = role === "owner" || role === "office_staff";

  return (
    <div className="space-y-2 border-t border-border pt-3" data-tour="house-notes">
      <div className="flex items-center gap-1.5 font-display text-[10px] uppercase tracking-widest text-muted-foreground">
        <StickyNote className="w-3.5 h-3.5" />
        House notes
      </div>

      {notes.map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-2 rounded-md border border-border bg-surface/60 px-2.5 py-2"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm leading-snug break-words">{n.note}</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">
              {n.name} · {timeAgo(n.created_at)}
            </div>
          </div>
          {(n.author_id === user?.id || canModerate) && (
            <button
              type="button"
              aria-label="Delete note"
              disabled={deleteNote.isPending}
              onClick={() => deleteNote.mutate(n.id)}
              className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-surface-elevated hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ))}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft.trim() && !addNote.isPending && user) addNote.mutate();
        }}
      >
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder="Gate code, dog, best time to come back…"
          aria-label="New house note"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={!draft.trim() || addNote.isPending || !user}
        >
          {addNote.isPending ? "Saving…" : "Save"}
        </Button>
      </form>
    </div>
  );
}
