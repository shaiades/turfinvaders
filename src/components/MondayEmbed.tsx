import { useEffect, useState } from "react";
import { ArcadePanel } from "@/components/arcade";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ExternalLink, Pencil, Check, X } from "lucide-react";

const STORAGE_KEY = "knockout.monday_form_url";

function isSafeUrl(u: string) {
  try {
    const url = new URL(u);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

export function MondayEmbed({ canEdit }: { canEdit: boolean }) {
  const [url, setUrl] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) ?? "";
    setUrl(saved);
    setDraft(saved);
    if (!saved && canEdit) setEditing(true);
  }, [canEdit]);

  const save = () => {
    if (draft && !isSafeUrl(draft)) return;
    localStorage.setItem(STORAGE_KEY, draft);
    setUrl(draft);
    setEditing(false);
  };

  return (
    <ArcadePanel
      title="Monday.com Lead Form"
      action={
        <div className="flex items-center gap-2">
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-display uppercase tracking-widest text-muted-foreground hover:text-neon inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" /> Open
            </a>
          )}
          {canEdit && !editing && (
            <Button size="sm" variant="ghost" onClick={() => { setDraft(url); setEditing(true); }}>
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> {url ? "Change URL" : "Set URL"}
            </Button>
          )}
        </div>
      }
    >
      {editing ? (
        <div className="space-y-3">
          <div>
            <Label className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
              Monday.com Form URL (https://)
            </Label>
            <Input
              className="mt-1.5"
              placeholder="https://forms.monday.com/forms/..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Paste the public share URL of your Monday.com form. Saved per device.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setDraft(url); setEditing(false); }}>
              <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!!draft && !isSafeUrl(draft)}>
              <Check className="w-3.5 h-3.5 mr-1.5" /> Save
            </Button>
          </div>
        </div>
      ) : !url ? (
        <p className="text-sm text-muted-foreground">
          No Monday.com form URL configured yet.
          {canEdit ? " Click Set URL to paste it." : " Ask an Owner to add it."}
        </p>
      ) : (
        <div className="relative w-full overflow-hidden rounded-lg border border-border bg-surface">
          <div className="absolute inset-0 pointer-events-none scanlines opacity-20" />
          <div className="absolute inset-0 pointer-events-none rounded-lg ring-1 ring-inset ring-[color-mix(in_oklab,var(--neon)_30%,transparent)] shadow-[0_0_30px_-10px_var(--neon)]" />
          <iframe
            title="Monday.com Lead Form"
            src={url}
            className="block w-full bg-white"
            style={{ height: "min(85vh, 900px)", border: 0 }}
            allow="clipboard-write; fullscreen"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      )}
    </ArcadePanel>
  );
}
