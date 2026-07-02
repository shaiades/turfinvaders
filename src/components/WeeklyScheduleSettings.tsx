import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

/** Accepts a full Monday URL or a raw ID, returns just the numeric board ID. */
export function extractMondayBoardId(input: string): string {
  if (!input) return "";
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/boards\/(\d{4,})/i);
  if (urlMatch) return urlMatch[1];
  const digits = trimmed.match(/\d{4,}/);
  return digits ? digits[0] : "";
}

export function WeeklyScheduleSettings() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["system_settings", "boards"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("active_monday_board_oc, active_monday_board_sd")
        .eq("id", true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [oc, setOc] = useState("");
  const [sd, setSd] = useState("");
  const [savingOc, setSavingOc] = useState(false);
  const [savingSd, setSavingSd] = useState(false);

  useEffect(() => {
    if (data) {
      setOc(data.active_monday_board_oc ?? "");
      setSd(data.active_monday_board_sd ?? "");
    }
  }, [data]);

  async function save(field: "active_monday_board_oc" | "active_monday_board_sd", value: string, label: string) {
    const boardId = extractMondayBoardId(value);
    if (!boardId) {
      toast.error(`Could not detect a Board ID for ${label}. Paste a Monday URL or numeric ID.`);
      return;
    }
    const setSaving = field === "active_monday_board_oc" ? setSavingOc : setSavingSd;
    const setLocal = field === "active_monday_board_oc" ? setOc : setSd;
    setSaving(true);
    const { error } = await supabase
      .from("system_settings")
      .upsert({ id: true, [field]: boardId } as never, { onConflict: "id" });
    setSaving(false);
    if (error) {
      toast.error(`Save failed: ${error.message}`);
      return;
    }
    setLocal(boardId);
    qc.invalidateQueries({ queryKey: ["system_settings", "boards"] });
    toast.success("Active Schedule Boards Updated!", {
      style: { background: "hsl(142 76% 36%)", color: "white", border: "1px solid hsl(142 76% 30%)" },
    });
  }

  return (
    <ArcadePanel
      title="Weekly Schedule Connections"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          Monday.com Boards
        </span>
      }
    >
      <p className="text-xs text-muted-foreground mb-4">
        Paste a full Monday.com board URL or the numeric ID. We'll auto-extract the ID.
      </p>

      <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="oc-board">Orange County Schedule Board</Label>
          <div className="flex gap-2">
            <Input
              id="oc-board"
              placeholder="https://company.monday.com/boards/123456789"
              value={oc}
              onChange={(e) => setOc(e.target.value)}
              disabled={isLoading}
            />
            <Button onClick={() => save("active_monday_board_oc", oc, "Orange County")} disabled={savingOc || isLoading}>
              {savingOc ? "Saving…" : "Save"}
            </Button>
          </div>
          {data?.active_monday_board_oc && (
            <p className="text-[11px] text-muted-foreground">Active: {data.active_monday_board_oc}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="sd-board">San Diego Schedule Board</Label>
          <div className="flex gap-2">
            <Input
              id="sd-board"
              placeholder="https://company.monday.com/boards/987654321"
              value={sd}
              onChange={(e) => setSd(e.target.value)}
              disabled={isLoading}
            />
            <Button onClick={() => save("active_monday_board_sd", sd, "San Diego")} disabled={savingSd || isLoading}>
              {savingSd ? "Saving…" : "Save"}
            </Button>
          </div>
          {data?.active_monday_board_sd && (
            <p className="text-[11px] text-muted-foreground">Active: {data.active_monday_board_sd}</p>
          )}
        </div>
      </div>
    </ArcadePanel>
  );
}
