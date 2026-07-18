import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle } from "lucide-react";

export type StatusMap = Record<string, "active" | "suspended" | "suspension_review" | "inactive">;

/** True for both suspension statuses the DB has used over time. */
export function isSuspendedStatus(status: string | null | undefined): boolean {
  return status === "suspended" || status === "suspension_review";
}

export function useCanvasserStatuses() {
  return useQuery({
    queryKey: ["profiles", "statuses"],
    queryFn: async (): Promise<StatusMap> => {
      const { data, error } = await supabase.from("profiles").select("id, status");
      if (error) throw error;
      const map: StatusMap = {};
      for (const r of data ?? []) map[r.id] = (r.status as StatusMap[string]) ?? "active";
      return map;
    },
    staleTime: 30_000,
  });
}

export function SuspendedBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-display uppercase tracking-widest border suspended-glow ${className}`}
    >
      <AlertTriangle className="w-3 h-3" /> Suspended
    </span>
  );
}
