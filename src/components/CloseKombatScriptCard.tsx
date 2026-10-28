import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { STAGE_LABEL, type RepScript, type ScriptStage } from "@/data/rep-scripts";

/**
 * One story script, expanded inside the Close Kombat Learn tab. All copy
 * comes from src/data/rep-scripts.ts. "Drill" hides every spoken line so a
 * rep can run the story from memory and tap a row to check it — the
 * teach-back test, solo.
 */

const STAGE_TEXT: Record<ScriptStage, string> = {
  attention: "text-turf-cyan",
  emotion: "text-kombat-red",
  imagery: "text-turf-pink",
  action: "text-victory",
};

function SubHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 text-[10px] font-display uppercase tracking-widest text-kombat-gold/80">
      {children}
    </div>
  );
}

export function CloseKombatScriptCard({ script }: { script: RepScript }) {
  const [drill, setDrill] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());

  const toggleDrill = () => {
    setDrill((d) => !d);
    setRevealed(new Set());
  };

  const reveal = (i: number) => {
    if (!drill) return;
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  return (
    <div className="space-y-5 text-sm leading-relaxed text-foreground/90">
      {script.setup && <p className="text-xs text-muted-foreground">{script.setup}</p>}

      {script.protect && (
        <p className="rounded-md border border-kombat-red/50 bg-kombat-red/10 px-3 py-2 text-xs">
          {script.protect}
        </p>
      )}

      {/* The story */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <SubHead>The story</SubHead>
          <button
            type="button"
            onClick={toggleDrill}
            aria-pressed={drill}
            className={`inline-flex min-h-11 md:min-h-8 items-center gap-1.5 rounded-md border px-3 text-[10px] font-display uppercase tracking-widest transition-colors ${
              drill
                ? "border-kombat-gold bg-kombat-gold/15 text-kombat-gold"
                : "border-border/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            {drill ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {drill ? "Drill on" : "Drill"}
          </button>
        </div>
        {drill && (
          <p className="mb-2 text-xs text-muted-foreground">
            Say each line out loud, then tap the row to check yourself.
          </p>
        )}
        <ol className="space-y-1.5">
          {script.rows.map((row, i) => {
            const hidden = drill && !revealed.has(i);
            return (
              <li key={i}>
                <button
                  type="button"
                  onClick={() => reveal(i)}
                  disabled={!drill}
                  className={`grid w-full grid-cols-1 gap-1 rounded-md px-3 py-2 text-left md:grid-cols-[8.5rem_minmax(0,1fr)] md:gap-3 ${
                    row.ask
                      ? "border-l-2 border-kombat-gold bg-kombat-gold/10"
                      : "border-l-2 border-transparent bg-surface/40"
                  } ${drill ? "cursor-pointer" : "cursor-default"}`}
                >
                  <span className="flex items-baseline gap-2 md:flex-col md:gap-0">
                    <span
                      className={`text-[10px] font-display uppercase tracking-widest ${
                        row.ask ? "text-kombat-gold" : STAGE_TEXT[row.stage]
                      }`}
                    >
                      {row.ask ? "Ask" : STAGE_LABEL[row.stage]}
                    </span>
                    {!row.ask && (
                      <span className="text-[11px] text-muted-foreground">{row.step}</span>
                    )}
                  </span>
                  <span className="min-w-0">
                    {hidden ? (
                      <span className="text-xs italic text-muted-foreground/70">
                        Tap to check your line
                      </span>
                    ) : (
                      <>
                        <span className="text-foreground">“{row.say}”</span>
                        {row.cue && (
                          <span className="ml-1 text-xs italic text-muted-foreground">
                            {row.cue}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      {/* The close */}
      <div className="rounded-md border border-kombat-gold/60 bg-kombat-black/60 px-4 py-3 shadow-[0_0_18px_-8px_var(--kombat-gold)]">
        <SubHead>The close · two options</SubHead>
        <div className="space-y-2">
          {script.close.map((line, i) => (
            <p key={i} className="text-foreground">
              “{line}”
            </p>
          ))}
        </div>
        <p className="mt-2 text-xs font-medium text-kombat-gold">{script.closeRule}</p>
      </div>

      {/* Options */}
      <div>
        <SubHead>{script.optionsTitle}</SubHead>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {script.options.map((o) => (
            <div key={o.title} className="rounded-md border border-border/50 px-3 py-2">
              {o.tag && (
                <div className="text-[10px] font-display uppercase tracking-widest text-muted-foreground">
                  {o.tag}
                </div>
              )}
              <div className="font-medium text-foreground">{o.title}</div>
              <p className="text-xs text-muted-foreground">{o.body}</p>
            </div>
          ))}
        </div>
        {script.note && (
          <p className="mt-2 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Rep note: </span>
            {script.note}
          </p>
        )}
      </div>

      {script.educate && (
        <div>
          <SubHead>{script.educate.title}</SubHead>
          <p className="mb-2 rounded-md border-l-2 border-kombat-gold bg-kombat-gold/10 px-3 py-2">
            <span className="mr-2 text-[10px] font-display uppercase tracking-widest text-kombat-gold">
              Ask
            </span>
            “{script.educate.ask}”
          </p>
          <ul className="space-y-1">
            {script.educate.points.map((p) => (
              <li key={p.title}>
                <span className="font-medium text-foreground">{p.title}: </span>
                <span className="text-muted-foreground">{p.body}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 italic">“{script.educate.quote}”</p>
          <p className="mt-2 rounded-md border border-kombat-red/50 bg-kombat-red/10 px-3 py-2 text-xs">
            <span className="font-medium text-kombat-red">Red flag: </span>
            {script.educate.redFlag}
          </p>
        </div>
      )}

      {script.points && script.pointsTitle && (
        <div>
          <SubHead>{script.pointsTitle}</SubHead>
          <ul className="space-y-1">
            {script.points.map((p) => (
              <li key={p.title}>
                <span className="font-medium text-foreground">{p.title}: </span>
                <span className="text-muted-foreground">{p.body}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {script.pushback && (
        <div>
          <SubHead>Common pushback</SubHead>
          <ul className="space-y-1.5">
            {script.pushback.map((p) => (
              <li key={p.q}>
                <span className="font-medium text-foreground">“{p.q}” </span>
                <span className="text-muted-foreground">{p.a}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <SubHead>{script.walkaroundTitle}</SubHead>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {script.walkaround.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
        <div>
          <SubHead>Avoid</SubHead>
          <ul className="space-y-1 text-muted-foreground">
            {script.avoid.map((a) => (
              <li key={a}>
                <span className="mr-1.5 text-kombat-red">✕</span>
                {a}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-md border border-victory/40 bg-victory/10 px-3 py-2">
        <SubHead>Teach-back: a pass sounds like</SubHead>
        <p className="italic text-foreground">“{script.teachBack}”</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Can't say it back? Simplify. Don't add facts.
        </p>
      </div>
    </div>
  );
}
