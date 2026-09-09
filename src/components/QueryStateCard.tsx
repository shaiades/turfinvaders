import { Button } from "@/components/ui/button";

/**
 * Zero ≠ error (go-live audit 2026-09-09): most canvasser surfaces used to
 * render a failed query exactly like a real zero — worst case the time clock
 * offering "Clock In" to someone already punched in. Render this INSTEAD of
 * the panel body while a query is pending or failed; render nothing (null)
 * yourself when the query is fine and show real data.
 *
 * Usage:
 *   if (q.isPending || q.isError)
 *     return <QueryStateCard pending={q.isPending} what="your stats" onRetry={() => q.refetch()} />;
 */
export function QueryStateCard({
  pending,
  what,
  onRetry,
}: {
  /** true = loading state; false = error state */
  pending: boolean;
  /** Fills "Couldn't load {what}." / "Loading {what}…" */
  what: string;
  onRetry?: () => void;
}) {
  if (pending) {
    return <div className="text-sm text-muted-foreground p-3">Loading {what}…</div>;
  }
  return (
    <div className="rounded-lg border border-warning/50 bg-warning/10 p-3 space-y-2">
      <div className="text-sm text-foreground/90">
        Couldn't load {what}. Check your signal and try again.
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
