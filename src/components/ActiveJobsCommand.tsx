import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { ArcadePanel } from "@/components/arcade";
import { useActiveJobRingDoors, useActiveJobs } from "@/components/ActiveJobs";
import { refreshActiveJobs } from "@/lib/production-jobs.functions";

/**
 * Captain Command: the "10 doors around every active job" standard as a
 * list (owner ask 2026-11-04). One row per In Progress Tidal job — street,
 * trades, and this week's door count inside its half-mile ring — sorted
 * under-knocked first so the next van stop is the top row. The refresh
 * button is the captain's on-demand Monday pull (15-min cooldown server-side;
 * the cron still runs the daily 6 AM sync).
 *
 * Same privacy surface as the map layer: street + rounded ring only — no
 * names, numbers, or exact addresses in this card, ever.
 */

const DOOR_GOAL = 10;

export function ActiveJobsCommand() {
  const qc = useQueryClient();
  const jobs = useActiveJobs();
  const doors = useActiveJobRingDoors(true);

  const refresh = useMutation({
    mutationFn: () => refreshActiveJobs(),
    onSuccess: ({ skipped }) => {
      qc.invalidateQueries({ queryKey: ["active_jobs_map"] });
      qc.invalidateQueries({ queryKey: ["active_job_ring_doors"] });
      toast(
        skipped
          ? "Already fresh — jobs synced within the last 15 minutes."
          : "Active jobs refreshed from Monday.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = [...(jobs.data ?? [])].sort(
    (a, b) => (doors.data?.get(a.monday_item_id) ?? 0) - (doors.data?.get(b.monday_item_id) ?? 0),
  );

  return (
    <ArcadePanel
      title="Active Jobs"
      action={
        <button
          type="button"
          aria-label="Refresh active jobs from Monday"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="flex min-h-11 md:min-h-0 items-center gap-1.5 rounded border border-border px-2.5 py-1 text-[10px] font-display uppercase tracking-widest text-muted-foreground hover:text-neon hover:border-neon/40 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refresh.isPending ? "animate-spin" : ""}`} />
          Refresh
        </button>
      }
    >
      {jobs.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading job sites…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No jobs in progress right now.</div>
      ) : (
        <>
          <ul>
            {rows.map((j) => {
              const n = doors.data?.get(j.monday_item_id) ?? 0;
              const met = n >= DOOR_GOAL;
              return (
                <li
                  key={j.monday_item_id}
                  className="flex items-center justify-between gap-3 border-b border-border/40 py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm">
                      {j.street ?? "Job site"}
                      {j.city && <span className="text-muted-foreground"> · {j.city}</span>}
                    </div>
                    {j.projects && (
                      <div className="truncate text-[11px] text-muted-foreground">{j.projects}</div>
                    )}
                  </div>
                  <div
                    className="shrink-0 font-display text-xs"
                    style={{ color: met ? "var(--victory)" : "var(--warning)" }}
                    title={`${n} doors knocked inside this ring this week — standard is ${DOOR_GOAL}`}
                  >
                    {n}/{DOOR_GOAL}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 text-[11px] text-muted-foreground">
            Doors knocked this week inside each job's half-mile ring · rings show on every map
          </div>
        </>
      )}
    </ArcadePanel>
  );
}
