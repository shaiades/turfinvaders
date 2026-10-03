// Canvasser fighters — admin manage gallery (Close Kombat, owner 2026-10-02).
// The field-crew mirror of KombatCartoonAdmin: canvassers have no Monday photo,
// so an owner/manager uploads a selfie per player and we generate their Street
// Fighter cartoon with Gemini. No review gate — it goes live on generate (owner:
// we iterate on the art later); Re-roll redraws from the same selfie. Players
// can also set their own from Mission (MyFighterCard). Admin-only.

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArcadePanel } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { Input } from "@/components/ui/input";
import {
  listCanvasserFightersFn,
  uploadCanvasserPhotoFn,
  generateCanvasserCartoonFn,
  type CanvasserFighterRow,
} from "@/lib/canvasser-fighters.functions";
import { fileToResizedDataUrl } from "@/lib/image-upload";
import { repCartoonsKey } from "@/hooks/useRepCartoons";

const ADMIN_KEY = ["canvasser_fighters_admin"] as const;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  none: { label: "No photo", cls: "text-muted-foreground border-border" },
  generating: { label: "Generating…", cls: "text-warning border-warning/50" },
  pending_review: { label: "Review", cls: "text-kombat-gold border-kombat-gold/50" },
  approved: { label: "Live", cls: "text-victory border-victory/50" },
  failed: { label: "Failed", cls: "text-destructive border-destructive/50" },
};

export function CanvasserCartoonAdmin() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ADMIN_KEY,
    queryFn: () => listCanvasserFightersFn(),
    staleTime: 15_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ADMIN_KEY });
    void qc.invalidateQueries({ queryKey: repCartoonsKey });
  };

  const upload = useMutation({
    mutationFn: (v: { profileId: string; dataUrl: string }) =>
      uploadCanvasserPhotoFn({ data: { profileId: v.profileId, dataUrl: v.dataUrl } }),
    onSuccess: (r) => {
      if (r.ok) toast.success(`${r.name}'s fighter is live`);
      else toast.error(`${r.name}: ${r.error ?? "generation failed"}`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Upload failed"),
  });

  const reroll = useMutation({
    mutationFn: (profileId: string) => generateCanvasserCartoonFn({ data: { profileId } }),
    onSuccess: (r) => {
      if (r.ok) toast.success("Fighter redrawn");
      else toast.error(`${r.name}: ${r.error ?? "failed"}`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Re-roll failed"),
  });

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.cartoon_status] = (c[r.cartoon_status] ?? 0) + 1;
    return c;
  }, [rows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
    // No-photo first (they need action), then failed, then live.
    const rank = (s: string) =>
      s === "none" ? 0 : s === "failed" ? 1 : s === "generating" ? 2 : 3;
    return [...base].sort(
      (a, b) => rank(a.cartoon_status) - rank(b.cartoon_status) || a.name.localeCompare(b.name),
    );
  }, [rows, q]);

  const pending = upload.isPending || reroll.isPending;

  return (
    <ArcadePanel
      title="Canvasser fighters (admin)"
      faction="kombat"
      status={list.isError ? "alert" : "good"}
      headline={
        <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
          {counts.approved ?? 0} live · {counts.none ?? 0} need a photo
        </span>
      }
    >
      {list.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load canvasser fighters — {String((list.error as Error).message)}. Has the
          canvasser_photos migration been applied?
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Upload a selfie for a player and we draw their fighter — it goes live right away and
            shows next to their name everywhere. Players can also set their own from Mission.
          </p>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a player…"
            className="mb-3 max-w-xs"
          />
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {rows.length === 0 ? "No field crew found." : "No matches."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((r) => (
                <CanvasserAdminCard
                  key={r.profile_id}
                  row={r}
                  pending={pending}
                  onUpload={(dataUrl) => upload.mutate({ profileId: r.profile_id, dataUrl })}
                  onReroll={() => reroll.mutate(r.profile_id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </ArcadePanel>
  );
}

function CanvasserAdminCard({
  row,
  pending,
  onUpload,
  onReroll,
}: {
  row: CanvasserFighterRow;
  pending: boolean;
  onUpload: (dataUrl: string) => void;
  onReroll: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [prepping, setPrepping] = useState(false);
  const meta = STATUS_META[row.cartoon_status] ?? STATUS_META.none;
  const hasArt = !!row.cartoon_portrait_url || !!row.cartoon_full_url;
  const cartoon = {
    name: row.name,
    portrait: row.cartoon_portrait_url,
    full: row.cartoon_full_url,
  };
  const busy = pending || prepping;

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setPrepping(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      onUpload(dataUrl);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't read that photo");
    } finally {
      setPrepping(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{row.name}</span>
        <span
          className={
            "shrink-0 rounded-full border px-2 py-0.5 font-display text-[9px] uppercase tracking-widest " +
            meta.cls
          }
        >
          {meta.label}
        </span>
      </div>
      <div className="truncate text-[11px] text-muted-foreground">
        {[row.office, row.role].filter(Boolean).join(" · ") || "Field crew"}
      </div>

      <div className="mt-2 flex items-center gap-3">
        <RepAvatar
          name={row.name}
          cartoon={row.cartoon_status === "approved" ? cartoon : undefined}
          variant="full"
          rounded="lg"
          className="h-16 w-16"
          textClassName="text-base"
        />
        <div className="flex flex-1 flex-wrap gap-1.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onPick(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <SmallBtn tone="gold" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "Working…" : hasArt ? "New photo" : "Upload photo"}
          </SmallBtn>
          {hasArt && (
            <SmallBtn tone="green" disabled={busy} onClick={onReroll}>
              Re-roll
            </SmallBtn>
          )}
        </div>
      </div>
    </div>
  );
}

function SmallBtn({
  children,
  onClick,
  disabled,
  tone,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone: "gold" | "green" | "red";
}) {
  const toneCls =
    tone === "green"
      ? "border-victory/50 text-victory hover:bg-victory/10"
      : tone === "red"
        ? "border-destructive/50 text-destructive hover:bg-destructive/10"
        : "border-kombat-gold/50 text-kombat-gold hover:bg-kombat-gold/10";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={
        "min-h-8 rounded border px-2 py-1 font-display text-[9px] uppercase tracking-widest transition-colors disabled:opacity-40 " +
        toneCls
      }
    >
      {children}
    </button>
  );
}
