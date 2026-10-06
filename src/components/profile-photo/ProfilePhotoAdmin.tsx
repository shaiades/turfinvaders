// Admin surface for the profile-photo gate (owner spec 2026-10-06 §4): the live
// "Users without a photo: N" roster — so Jose Miranda shows here until he adds
// one — plus the "Remind me later" escape-valve toggle. Mounted on Manage
// Players (/users), which is already Owner/Manager-gated.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Camera, RefreshCw } from "lucide-react";
import { ArcadePanel, ArcadeSkeleton } from "@/components/arcade";
import { ROLE_LABEL, type AppRole, isAppRole } from "@/lib/roles";
import {
  listMissingPhotosFn,
  getPhotoGateConfigFn,
  setPhotoRemindLaterFn,
} from "@/lib/profile-photo.functions";

export function ProfilePhotoAdmin() {
  const qc = useQueryClient();

  const missing = useQuery({
    queryKey: ["missing_photos"],
    staleTime: 60_000,
    queryFn: () => listMissingPhotosFn(),
  });

  const cfg = useQuery({
    queryKey: ["photo_gate_config"],
    staleTime: 5 * 60_000,
    queryFn: () => getPhotoGateConfigFn(),
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setPhotoRemindLaterFn({ data: { enabled } }),
    onSuccess: (r) => {
      toast.success(
        r.enabled
          ? "Players can now tap “Remind me later” (after 3 logins)."
          : "Photo step is now fully blocking.",
      );
      void qc.invalidateQueries({ queryKey: ["photo_gate_config"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save that."),
  });

  const data = missing.data;
  const remindLater = cfg.data?.remindLaterEnabled === true;
  const count = data?.missing.length ?? 0;

  return (
    <ArcadePanel
      title={`Users Without a Photo${data ? ` (${count})` : ""}`}
      action={
        <button
          type="button"
          onClick={() => missing.refetch()}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border px-2.5 text-[10px] font-display uppercase tracking-widest text-muted-foreground hover:text-foreground"
          aria-label="Refresh"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${missing.isFetching ? "animate-spin" : ""}`} />{" "}
          Refresh
        </button>
      }
    >
      {/* Remind-later toggle */}
      <label className="mb-4 flex items-start gap-3 rounded-lg border border-border bg-surface/60 p-3">
        <input
          type="checkbox"
          checked={remindLater}
          disabled={cfg.isLoading || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-kombat-gold"
        />
        <span className="text-xs">
          <span className="block font-display uppercase tracking-widest text-foreground">
            Allow “Remind me later”
          </span>
          <span className="block text-muted-foreground">
            Off (default) = the photo step is fully blocking for every player. On = a small “Remind
            me later” link appears, but only after a player has seen it 3+ times.
          </span>
        </span>
      </label>

      {missing.isLoading ? (
        <ArcadeSkeleton className="h-24 w-full" />
      ) : missing.error ? (
        <p className="text-sm text-destructive">
          {missing.error instanceof Error ? missing.error.message : "Couldn't load the list."}
        </p>
      ) : count === 0 ? (
        <p className="flex items-center gap-2 text-sm text-victory">
          <Camera className="h-4 w-4" /> Everyone has a photo. 🎉
        </p>
      ) : (
        <ul className="divide-y divide-border/60">
          {data!.missing.map((m) => {
            const roleLabel = isAppRole(m.role) ? ROLE_LABEL[m.role as AppRole] : (m.role ?? "—");
            return (
              <li key={m.profile_id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-sm text-foreground">{m.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {m.office && <span className="hidden sm:inline">{m.office}</span>}
                  <span className="rounded border border-border px-1.5 py-0.5">{roleLabel}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </ArcadePanel>
  );
}
