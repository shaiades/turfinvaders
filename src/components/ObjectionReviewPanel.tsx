import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { ArcadePanel } from "@/components/arcade";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  dojoTable,
  signedAttemptUrl,
  useAttemptNames,
  useObjections,
  type ObjectionAttempt,
} from "@/components/ObjectionDojo";
import { toast } from "sonner";
import { Check, Eye, Plus, X } from "lucide-react";

/**
 * Objection Dojo review queue — lives on the Confirmation Desk beside the
 * lead queue, same approve/deny rhythm. Owners + Managers only (the desk
 * route is already admin-gated; RLS enforces it again server-side).
 * Renders nothing until the Dojo migration has been applied.
 */
export function ObjectionReviewPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const objections = useObjections();

  const pending = useQuery({
    enabled: objections.isSuccess,
    queryKey: ["objection_attempts", "pending"],
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await dojoTable("objection_attempts")
        .select("*")
        .eq("status", "pending")
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as ObjectionAttempt[];
    },
  });

  const names = useAttemptNames(pending.data ?? []);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const review = useMutation({
    mutationFn: async (vars: {
      id: string;
      status: "approved" | "denied";
      deny_reason?: string;
    }) => {
      const { error } = await dojoTable("objection_attempts")
        .update({
          status: vars.status,
          deny_reason: vars.deny_reason ?? null,
          reviewed_by: user?.id,
          reviewed_at: new Date().toISOString(),
        } as never)
        .eq("id", vars.id);
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      toast.success(vars.status === "approved" ? "Attempt is live!" : "Attempt denied");
      setDenyFor(null);
      setDenyReason("");
      qc.invalidateQueries({ queryKey: ["objection_attempts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Quietly absent until the migration lands — the desk shouldn't error.
  if (objections.isError) return null;

  const byId = new Map((objections.data ?? []).map((o) => [o.id, o]));

  return (
    <div className="space-y-8">
      <ArcadePanel
        title="Objection Dojo · Review"
        action={
          <span className="text-[10px] font-display uppercase tracking-widest text-warning">
            {pending.data?.length ?? 0} waiting
          </span>
        }
      >
        {pending.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (pending.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No attempts waiting. Approved answers go live in the Learn tab instantly.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {pending.data!.map((a) => (
              <li key={a.id} className="py-3 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {names.data?.get(a.canvasser_id) ?? "…"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {byId.get(a.objection_id)?.title ?? "Unknown objection"} ·{" "}
                      {new Date(a.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          setPreview({ id: a.id, url: await signedAttemptUrl(a.storage_path) });
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Eye className="w-3.5 h-3.5 mr-1.5" /> Watch
                    </Button>
                    <Button
                      size="sm"
                      disabled={review.isPending}
                      onClick={() => review.mutate({ id: a.id, status: "approved" })}
                      className="bg-victory text-background hover:bg-victory/90"
                    >
                      <Check className="w-3.5 h-3.5 mr-1.5" /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={review.isPending}
                      onClick={() => setDenyFor(denyFor === a.id ? null : a.id)}
                    >
                      <X className="w-3.5 h-3.5 mr-1.5" /> Deny
                    </Button>
                  </div>
                </div>
                {preview?.id === a.id && (
                  <video
                    src={preview.url}
                    controls
                    autoPlay
                    playsInline
                    className="w-full max-w-md rounded-lg border border-border bg-black aspect-video object-contain"
                  />
                )}
                {denyFor === a.id && (
                  <div className="flex items-end gap-2">
                    <Textarea
                      rows={1}
                      value={denyReason}
                      onChange={(e) => setDenyReason(e.target.value)}
                      placeholder="Why (optional) — the player sees this"
                      className="max-w-md"
                    />
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={review.isPending}
                      onClick={() =>
                        review.mutate({
                          id: a.id,
                          status: "denied",
                          deny_reason: denyReason || undefined,
                        })
                      }
                    >
                      Confirm Deny
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </ArcadePanel>

      <AddObjectionCard />
    </div>
  );
}

function AddObjectionCard() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");

  const add = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error("Give the objection a title");
      const { error } = await dojoTable("objections").insert({
        title: title.trim(),
        prompt: prompt.trim() || null,
        sort: 99,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Objection added to the Dojo");
      setTitle("");
      setPrompt("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["objections"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <ArcadePanel
      title="Add Objection"
      action={
        <Button variant={open ? "ghost" : "default"} onClick={() => setOpen((o) => !o)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" /> {open ? "Close" : "New Objection"}
        </Button>
      }
    >
      {!open ? (
        <p className="text-xs text-muted-foreground">
          Add a new objection card for the team to practice against.
        </p>
      ) : (
        <div className="space-y-3 max-w-md">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`"It's Too Expensive"`}
            maxLength={120}
          />
          <Textarea
            rows={2}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Coaching hint shown under the title…"
            maxLength={300}
          />
          <div className="flex justify-end">
            <Button onClick={() => add.mutate()} disabled={add.isPending}>
              {add.isPending ? "Adding…" : "Add Objection"}
            </Button>
          </div>
        </div>
      )}
    </ArcadePanel>
  );
}
