// Rep fighters — admin review gallery (Close Kombat, owner 2026-10-02). Pull
// Monday photos, generate Street Fighter cartoons with Gemini, and Approve /
// Re-roll / Reject each one. Only an approved cartoon reaches the team board, so
// an off result never leaks. Admin-only (mounted behind isAdmin && !isPreview).

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArcadePanel, NeonButton } from "@/components/arcade";
import { RepAvatar } from "@/components/RepAvatar";
import { Input } from "@/components/ui/input";
import {
  listRepFighters,
  syncRepPhotosFn,
  generateCartoonsFn,
  reviewCartoonFn,
  type RepFighterRow,
} from "@/lib/rep-fighters.functions";
import { repCartoonsKey } from "@/hooks/useRepCartoons";

const ADMIN_KEY = ["rep_fighters_admin"] as const;

const STATUS_META: Record<string, { label: string; cls: string }> = {
  none: { label: "No art", cls: "text-muted-foreground border-border" },
  generating: { label: "Generating…", cls: "text-warning border-warning/50" },
  pending_review: { label: "Review", cls: "text-kombat-gold border-kombat-gold/50" },
  approved: { label: "Live", cls: "text-victory border-victory/50" },
  failed: { label: "Failed", cls: "text-destructive border-destructive/50" },
};

export function KombatCartoonAdmin() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");

  const list = useQuery({
    queryKey: ADMIN_KEY,
    queryFn: () => listRepFighters(),
    staleTime: 15_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ADMIN_KEY });
    void qc.invalidateQueries({ queryKey: repCartoonsKey });
  };

  const sync = useMutation({
    mutationFn: () => syncRepPhotosFn(),
    onSuccess: (r) => {
      toast.success(`Synced ${r.fetched} Monday photos (${r.reset_for_regen} queued to regen)`);
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Photo sync failed"),
  });

  const genBatch = useMutation({
    mutationFn: () => generateCartoonsFn({ data: { limit: 6 } }),
    onSuccess: (r) => {
      toast.success(
        `Generated ${r.ok}/${r.attempted} fighters${r.failed ? ` · ${r.failed} failed` : ""}`,
      );
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Generation failed"),
  });

  const genOne = useMutation({
    mutationFn: (id: number) => generateCartoonsFn({ data: { mondayUserIds: [id] } }),
    onSuccess: (r) => {
      const first = r.results[0];
      if (first && !first.ok) toast.error(`${first.name}: ${first.error ?? "failed"}`);
      else toast.success("Fighter generated — review it below");
      refresh();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Generation failed"),
  });

  const review = useMutation({
    mutationFn: (v: { id: number; action: "approve" | "reject" | "reroll" }) =>
      reviewCartoonFn({ data: { mondayUserId: v.id, action: v.action } }),
    onSuccess: () => refresh(),
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
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
    // Review-worthy first, then no-art, then live.
    const rank = (s: string) =>
      s === "pending_review"
        ? 0
        : s === "failed"
          ? 1
          : s === "none"
            ? 2
            : s === "generating"
              ? 3
              : 4;
    return [...base].sort((a, b) => rank(a.cartoon_status) - rank(b.cartoon_status));
  }, [rows, q]);

  const busy = sync.isPending || genBatch.isPending;

  return (
    <ArcadePanel
      title="Rep fighters (admin)"
      faction="kombat"
      status={list.isError ? "alert" : "good"}
      headline={
        <span className="font-display text-[10px] uppercase tracking-widest text-muted-foreground">
          {counts.approved ?? 0} live · {counts.pending_review ?? 0} to review
        </span>
      }
      action={
        <div className="flex flex-wrap gap-2">
          <NeonButton tone="kombat-gold" disabled={busy} onClick={() => sync.mutate()}>
            {sync.isPending ? "Syncing…" : "Sync photos"}
          </NeonButton>
          <NeonButton tone="kombat-red" disabled={busy} onClick={() => genBatch.mutate()}>
            {genBatch.isPending ? "Generating…" : "Generate next 6"}
          </NeonButton>
        </div>
      }
    >
      {list.isError ? (
        <p className="text-sm text-muted-foreground">
          Couldn't load fighters — {String((list.error as Error).message)}. Has the rep_photos
          migration been applied?
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Sync pulls every Monday profile photo; generate turns the ~17 active reps into Street
            Fighter cartoons. Nothing shows to the team until you{" "}
            <span className="text-victory">Approve</span>.
          </p>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search a rep…"
            className="mb-3 max-w-xs"
          />
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {rows.length === 0 ? "No photos yet — run Sync photos." : "No matches."}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filtered.map((r) => (
                <FighterAdminCard
                  key={r.monday_user_id}
                  row={r}
                  onGenerate={() => genOne.mutate(r.monday_user_id)}
                  onApprove={() => review.mutate({ id: r.monday_user_id, action: "approve" })}
                  onReject={() => review.mutate({ id: r.monday_user_id, action: "reject" })}
                  onReroll={() => genOne.mutate(r.monday_user_id)}
                  pending={genOne.isPending || review.isPending}
                />
              ))}
            </div>
          )}
        </>
      )}
    </ArcadePanel>
  );
}

function FighterAdminCard({
  row,
  onGenerate,
  onApprove,
  onReject,
  onReroll,
  pending,
}: {
  row: RepFighterRow;
  onGenerate: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReroll: () => void;
  pending: boolean;
}) {
  const meta = STATUS_META[row.cartoon_status] ?? STATUS_META.none;
  const hasArt = !!row.cartoon_portrait_url || !!row.cartoon_full_url;
  const cartoon = {
    name: row.name,
    portrait: row.cartoon_portrait_url,
    full: row.cartoon_full_url,
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
      {row.title && <div className="truncate text-[11px] text-muted-foreground">{row.title}</div>}

      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <Thumb label="Real" src={row.photo_url} alt={`${row.name} photo`} />
        <Thumb
          label="Portrait"
          src={row.cartoon_portrait_url}
          alt={`${row.name} portrait`}
          fallback={!hasArt}
        />
        <Thumb
          label="Full"
          src={row.cartoon_full_url}
          alt={`${row.name} full body`}
          fallback={!hasArt}
        />
      </div>

      {/* How the team will see them (approved art or initials). */}
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <RepAvatar
          name={row.name}
          cartoon={row.cartoon_status === "approved" ? cartoon : undefined}
          className="h-7 w-7"
          textClassName="text-[0.6rem]"
        />
        On the board
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {!hasArt ? (
          <SmallBtn tone="gold" disabled={pending || !row.photo_url} onClick={onGenerate}>
            Generate
          </SmallBtn>
        ) : (
          <>
            {row.cartoon_status !== "approved" && (
              <SmallBtn tone="green" disabled={pending} onClick={onApprove}>
                Approve
              </SmallBtn>
            )}
            <SmallBtn tone="gold" disabled={pending} onClick={onReroll}>
              Re-roll
            </SmallBtn>
            <SmallBtn tone="red" disabled={pending} onClick={onReject}>
              {row.cartoon_status === "approved" ? "Unpublish" : "Reject"}
            </SmallBtn>
          </>
        )}
      </div>
    </div>
  );
}

function Thumb({
  label,
  src,
  alt,
  fallback,
}: {
  label: string;
  src: string | null;
  alt: string;
  fallback?: boolean;
}) {
  return (
    <div>
      <div className="aspect-square overflow-hidden rounded border border-border bg-kombat-black/40">
        {src ? (
          // Reviewers judge the WHOLE image before approving — contain, never a
          // center-crop that hides the head/feet of the full-body art.
          <img src={src} alt={alt} loading="lazy" className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full w-full place-items-center text-[9px] text-muted-foreground">
            {fallback ? "—" : ""}
          </div>
        )}
      </div>
      <div className="mt-0.5 text-center text-[9px] uppercase tracking-widest text-muted-foreground">
        {label}
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
