// "Generate spin frames" — the admin button that gives every approved fighter
// its videogame turnaround (8 views at 45°) for the stats-page turntable
// (owner 2026-11-02). One server fn covers BOTH casts (reps + canvassers), so
// the button drains everyone no matter which fighter-admin panel it sits in.
// Loops the bounded fn (each call = 7 Gemini image gens per fighter) until the
// queue is dry — the same drain pattern as the re-roll-all button.

import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { NeonButton } from "@/components/arcade";
import { generateTurnaroundsFn } from "@/lib/fighter-turnaround.functions";
import { repCartoonsKey } from "@/hooks/useRepCartoons";

export function TurnaroundAdminButton({ disabled = false }: { disabled?: boolean }) {
  const qc = useQueryClient();
  const [run, setRun] = useState<{ running: boolean; done: number; failed: number }>({
    running: false,
    done: 0,
    failed: 0,
  });

  const start = async () => {
    setRun({ running: true, done: 0, failed: 0 });
    let done = 0;
    let failed = 0;
    try {
      let prevRemaining = Infinity;
      for (let i = 0; i < 100; i++) {
        const r = await generateTurnaroundsFn({ data: { limit: 1 } });
        done += r.ok;
        failed += r.failed;
        setRun({ running: true, done, failed });
        void qc.invalidateQueries({ queryKey: repCartoonsKey });
        if (r.remaining <= 0) break;
        // Zero forward progress = the leading fighter is unprocessable;
        // looping would just reburn Gemini budget on the same failure.
        if (r.ok === 0 && r.remaining >= prevRemaining) break;
        prevRemaining = r.remaining;
      }
      toast.success(
        done === 0 && failed === 0
          ? "Everyone's spin frames are already up to date"
          : `Spin frames drawn for ${done} fighter${done === 1 ? "" : "s"}${
              failed ? ` · ${failed} failed` : ""
            }`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Spin-frame generation failed");
    } finally {
      setRun((s) => ({ ...s, running: false }));
      void qc.invalidateQueries({ queryKey: repCartoonsKey });
    }
  };

  return (
    <NeonButton tone="kombat-gold" disabled={disabled || run.running} onClick={() => void start()}>
      {run.running
        ? `Spinning… ${run.done}${run.failed ? ` · ${run.failed} failed` : ""}`
        : "Generate spin frames"}
    </NeonButton>
  );
}
