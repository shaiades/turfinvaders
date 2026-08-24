import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Bell, BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { enablePush, getPushStatus, sendTestPush, type PushStatus } from "@/lib/push";

/** Compact enable/status row for flagged-punch push alerts. Sits beside the
 *  review queue on the captain dashboard and the Timesheets tab — always
 *  rendered (unlike the queue, which hides when clean) so alerts can be
 *  enabled before anything is ever flagged. */
export function PushAlertsCard() {
  const { user } = useAuth();
  const userId = user?.id;
  const [status, setStatus] = useState<PushStatus | null>(null);

  const statusQuery = useQuery({
    queryKey: ["push-status"],
    queryFn: getPushStatus,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (statusQuery.data) setStatus(statusQuery.data);
  }, [statusQuery.data]);

  const enable = useMutation({
    mutationFn: () => {
      if (!userId) throw new Error("Still signing in — try again in a second");
      return enablePush(userId);
    },
    onSuccess: (s) => {
      setStatus(s);
      if (s === "on") toast.success("Punch alerts on for this device");
      else if (s === "blocked")
        toast.error("Notifications are blocked", {
          description: "Allow notifications for this site in your browser settings, then retry.",
        });
    },
    onError: (e: Error) => toast.error("Couldn't enable alerts", { description: e.message }),
  });

  const test = useMutation({
    mutationFn: sendTestPush,
    onSuccess: (r) =>
      r.sent > 0
        ? toast.success(`Test sent to ${r.sent} device${r.sent === 1 ? "" : "s"}`)
        : toast.warning("No registered devices found — enable alerts first"),
    onError: (e: Error) => toast.error("Test failed", { description: e.message }),
  });

  if (status === null || !userId) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2">
      <div className="flex items-center gap-2 text-[10px] font-display uppercase tracking-widest text-muted-foreground">
        {status === "on" ? (
          <BellRing className="w-3.5 h-3.5 text-victory" />
        ) : status === "blocked" ? (
          <BellOff className="w-3.5 h-3.5 text-destructive" />
        ) : (
          <Bell className="w-3.5 h-3.5" />
        )}
        Punch alerts ·{" "}
        {status === "on"
          ? "on for this device"
          : status === "blocked"
            ? "blocked in browser settings"
            : status === "unsupported"
              ? "install the app to your home screen to enable"
              : "off"}
      </div>
      <div className="flex items-center gap-2">
        {(status === "off" || status === "blocked") && (
          <Button
            size="sm"
            variant="outline"
            disabled={enable.isPending}
            onClick={() => enable.mutate()}
            className="font-display text-[10px] uppercase tracking-widest"
          >
            Enable alerts
          </Button>
        )}
        {status === "on" && (
          <Button
            size="sm"
            variant="ghost"
            disabled={test.isPending}
            onClick={() => test.mutate()}
            className="font-display text-[10px] uppercase tracking-widest text-muted-foreground"
          >
            Send test
          </Button>
        )}
      </div>
    </div>
  );
}
