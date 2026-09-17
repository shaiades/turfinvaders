import { useEffect, useMemo, useState } from "react";
import { ArcadePanel, ArcadeCard } from "@/components/arcade";
import { ChevronDown, ChevronUp, BookOpen } from "lucide-react";
import { PLAYBOOK_CATEGORY_LABEL, REP_PLAYBOOK, type PlaybookCategory } from "@/data/rep-playbook";

/**
 * The rep-facing Learn tab (owner request 2026-09-17): the Infinity Sale
 * Playbook, adapted into in-app lessons. Read-progress is a per-device
 * localStorage flag only (mirrors the ti_-prefixed device-flag convention
 * used elsewhere — tours, seen-celebration flags) — low-stakes, no table.
 */

const readKey = (userId: string | null) => `ti_rep_playbook_read:${userId ?? "anon"}:v1`;

function loadRead(userId: string | null): Set<string> {
  try {
    const raw = window.localStorage.getItem(readKey(userId));
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveRead(userId: string | null, ids: Set<string>) {
  try {
    window.localStorage.setItem(readKey(userId), JSON.stringify([...ids]));
  } catch {
    /* private-mode quota — non-essential */
  }
}

const CATEGORY_ORDER: PlaybookCategory[] = [
  "mindset",
  "money-math",
  "touchpoints",
  "video-engine",
  "neighbors",
  "reload",
  "final-walk",
  "referrals",
];

export function CloseKombatLearnTab({ userId }: { userId: string | null }) {
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    setRead(loadRead(userId));
  }, [userId]);

  const byCategory = useMemo(() => {
    const groups = new Map<PlaybookCategory, typeof REP_PLAYBOOK>();
    for (const cat of CATEGORY_ORDER) groups.set(cat, []);
    for (const s of [...REP_PLAYBOOK].sort((a, b) => a.order - b.order)) {
      const g = groups.get(s.category);
      if (g) g.push(s);
    }
    return groups;
  }, []);

  const toggle = (id: string) => {
    const next = openId === id ? null : id;
    setOpenId(next);
    if (next && !read.has(id)) {
      const updated = new Set(read).add(id);
      setRead(updated);
      saveRead(userId, updated);
    }
  };

  const totalRead = read.size;

  return (
    <ArcadePanel
      faction="kombat"
      title="Learn"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {totalRead} / {REP_PLAYBOOK.length} read
        </span>
      }
    >
      <div className="space-y-6">
        <p className="text-xs text-muted-foreground">
          The Infinity Sale Mindset — how to turn one canvass sale into a franchise: reloads,
          neighbor sales, and referrals, stacked on the same deal.
        </p>
        {CATEGORY_ORDER.map((cat) => {
          const sections = byCategory.get(cat) ?? [];
          if (sections.length === 0) return null;
          return (
            <div key={cat}>
              <div className="mb-2 text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
                {PLAYBOOK_CATEGORY_LABEL[cat]}
              </div>
              <div className="space-y-2">
                {sections.map((s) => {
                  const isOpen = openId === s.id;
                  const isRead = read.has(s.id);
                  return (
                    <ArcadeCard key={s.id} faction="kombat" className="p-0 overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggle(s.id)}
                        className="flex w-full items-center gap-3 p-4 text-left min-h-11"
                      >
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            isRead ? "bg-victory" : "bg-kombat-gold"
                          }`}
                          aria-hidden
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium text-sm">{s.title}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {s.readMinutes} min read
                          </span>
                        </span>
                        {isOpen ? (
                          <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
                        )}
                      </button>
                      {isOpen && (
                        <div className="border-t border-border/40 px-4 pb-4 pt-3 space-y-3 text-sm leading-relaxed text-foreground/90">
                          {s.body.split("\n\n").map((para, i) =>
                            para.trimStart().startsWith("- ") ? (
                              <ul key={i} className="list-disc space-y-1 pl-5">
                                {para
                                  .split("\n")
                                  .map((line) => line.replace(/^- /, "").trim())
                                  .filter(Boolean)
                                  .map((line, j) => (
                                    <li key={j}>{line}</li>
                                  ))}
                              </ul>
                            ) : (
                              <p key={i}>{para}</p>
                            ),
                          )}
                        </div>
                      )}
                    </ArcadeCard>
                  );
                })}
              </div>
            </div>
          );
        })}
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <BookOpen className="w-3.5 h-3.5" /> Adapted from Tidal's Infinity Sale Playbook.
        </p>
      </div>
    </ArcadePanel>
  );
}
