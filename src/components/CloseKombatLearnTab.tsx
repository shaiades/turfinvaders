import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArcadePanel, ArcadeCard } from "@/components/arcade";
import { ChevronDown, ChevronUp, BookOpen } from "lucide-react";
import { PLAYBOOK_CATEGORY_LABEL, REP_PLAYBOOK, type PlaybookCategory } from "@/data/rep-playbook";
import { REP_SCRIPTS, ROLE_PLAY, STORY_METHOD } from "@/data/rep-scripts";
import { CloseKombatScriptCard } from "@/components/CloseKombatScriptCard";

/**
 * The rep-facing Learn tab (owner request 2026-09-17): the Infinity Sale
 * Playbook, adapted into in-app lessons. Read-progress is a per-device
 * localStorage flag only (mirrors the ti_-prefixed device-flag convention
 * used elsewhere — tours, seen-celebration flags) — low-stakes, no table.
 *
 * Sales Scripts (owner request 2026-10-28) sit above the playbook: the
 * story-script method, the five upsell story scripts (src/data/rep-scripts.ts)
 * and the role-play drill. They share the same read-progress set.
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

/** Plain-text body: blank line = paragraph, "- " lines = bullets. */
function TextBody({ body }: { body: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-foreground/90">
      {body.split("\n\n").map((para, i) =>
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
  );
}

function LearnItem({
  title,
  meta,
  isOpen,
  isRead,
  onToggle,
  children,
}: {
  title: string;
  meta: string;
  isOpen: boolean;
  isRead: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <ArcadeCard faction="kombat" className="p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 p-4 text-left min-h-11"
      >
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${isRead ? "bg-victory" : "bg-kombat-gold"}`}
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">{title}</span>
          <span className="text-[10px] text-muted-foreground">{meta}</span>
        </span>
        {isOpen ? (
          <ChevronUp className="w-4 h-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {isOpen && <div className="border-t border-border/40 px-4 pb-4 pt-3">{children}</div>}
    </ArcadeCard>
  );
}

const SCRIPT_ITEMS = [...REP_SCRIPTS].sort((a, b) => a.order - b.order);

/** Every id the read counter knows about — stale ids in storage don't count. */
const ALL_IDS = new Set<string>([
  STORY_METHOD.id,
  ...SCRIPT_ITEMS.map((s) => s.id),
  ROLE_PLAY.id,
  ...REP_PLAYBOOK.map((s) => s.id),
]);

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

  const totalRead = [...read].filter((id) => ALL_IDS.has(id)).length;

  const groupLabel = (label: string) => (
    <div className="mb-2 text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
      {label}
    </div>
  );

  return (
    <ArcadePanel
      faction="kombat"
      title="Learn"
      action={
        <span className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
          {totalRead} / {ALL_IDS.size} read
        </span>
      }
    >
      <div className="space-y-8">
        <section className="space-y-3">
          <div>
            <h3 className="font-display text-sm uppercase tracking-widest text-kombat-gold">
              Sales Scripts
            </h3>
            <p className="text-xs text-muted-foreground">
              Every story the same way: a question about their home, why it matters, one picture
              they can repeat, and two options. Then stop talking.
            </p>
          </div>
          <div className="space-y-2">
            <LearnItem
              title={STORY_METHOD.title}
              meta={`${STORY_METHOD.readMinutes} min read · start here`}
              isOpen={openId === STORY_METHOD.id}
              isRead={read.has(STORY_METHOD.id)}
              onToggle={() => toggle(STORY_METHOD.id)}
            >
              <TextBody body={STORY_METHOD.body} />
            </LearnItem>
          </div>
          <div>
            {groupLabel("Story Scripts")}
            <div className="space-y-2">
              {SCRIPT_ITEMS.map((s) => (
                <LearnItem
                  key={s.id}
                  title={s.title}
                  meta={s.tagline}
                  isOpen={openId === s.id}
                  isRead={read.has(s.id)}
                  onToggle={() => toggle(s.id)}
                >
                  <CloseKombatScriptCard script={s} />
                </LearnItem>
              ))}
            </div>
          </div>
          <div>
            {groupLabel("Practice")}
            <LearnItem
              title={ROLE_PLAY.title}
              meta={`${ROLE_PLAY.readMinutes} min read · run it in pairs`}
              isOpen={openId === ROLE_PLAY.id}
              isRead={read.has(ROLE_PLAY.id)}
              onToggle={() => toggle(ROLE_PLAY.id)}
            >
              <TextBody body={ROLE_PLAY.body} />
            </LearnItem>
          </div>
        </section>

        <section className="space-y-6">
          <div>
            <h3 className="font-display text-sm uppercase tracking-widest text-kombat-gold">
              The Infinity Sale Playbook
            </h3>
            <p className="text-xs text-muted-foreground">
              The Infinity Sale Mindset — how to turn one canvass sale into a franchise: reloads,
              neighbor sales, and referrals, stacked on the same deal.
            </p>
          </div>
          {CATEGORY_ORDER.map((cat) => {
            const sections = byCategory.get(cat) ?? [];
            if (sections.length === 0) return null;
            return (
              <div key={cat}>
                {groupLabel(PLAYBOOK_CATEGORY_LABEL[cat])}
                <div className="space-y-2">
                  {sections.map((s) => (
                    <LearnItem
                      key={s.id}
                      title={s.title}
                      meta={`${s.readMinutes} min read`}
                      isOpen={openId === s.id}
                      isRead={read.has(s.id)}
                      onToggle={() => toggle(s.id)}
                    >
                      <TextBody body={s.body} />
                    </LearnItem>
                  ))}
                </div>
              </div>
            );
          })}
        </section>
        <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <BookOpen className="w-3.5 h-3.5" /> Scripts from Tidal's upsell playbooks · playbook
          adapted from Tidal's Infinity Sale Playbook.
        </p>
      </div>
    </ArcadePanel>
  );
}
