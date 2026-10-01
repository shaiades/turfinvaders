import { useState } from "react";
import { toast } from "sonner";
import { CalendarOff, Stethoscope, UserX } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { laTodayISO } from "@/lib/dates";
import { useDayOffMutations, type DayOffKind } from "@/hooks/useDayOff";

/**
 * Captain quick-mark for an off-clock crew member: Sick / No-show / Excused
 * for TODAY. These are records, not requests — the RPC auto-approves a
 * captain's entry for someone on their van (never for themself) and the
 * worker gets a push so nothing lands behind their back.
 */
export function CrewAbsenceSheet({
  open,
  onOpenChange,
  member,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  member: { id: string; name: string } | null;
}) {
  const { submit } = useDayOffMutations();
  const [note, setNote] = useState("");

  const mark = (kind: DayOffKind) => {
    if (!member) return;
    submit.mutate(
      { userId: member.id, dates: [laTodayISO()], kind, reason: note.trim() || undefined },
      {
        onSuccess: (res) => {
          if (res.ok > 0) {
            toast.success(`${member.name} marked ${kind.replace("_", "-")} for today`);
            setNote("");
            onOpenChange(false);
          } else {
            toast.error("Already has an absence recorded for today");
          }
        },
        onError: (e: Error) => toast.error("Couldn't record that", { description: e.message }),
      },
    );
  };

  const btn =
    "w-full min-h-12 flex items-center justify-center gap-2 rounded border font-display text-xs uppercase tracking-widest transition-colors disabled:opacity-50";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="px-4 pb-safe">
        <SheetHeader className="text-left pt-2">
          <SheetTitle className="font-display uppercase tracking-widest text-sm">
            Mark {member?.name ?? ""} absent · today
          </SheetTitle>
          <SheetDescription>
            This is a record, not a request — it applies immediately, shows as EXCUSED on
            dispatch, and {member?.name ?? "they"} gets a notification.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-3 pb-6">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Note · optional — e.g. "texted at 6:40, fever"'
            className="text-base md:text-sm"
          />
          <button
            disabled={submit.isPending}
            onClick={() => mark("sick")}
            className={`${btn} border-warning/50 text-warning hover:bg-warning/10`}
          >
            <Stethoscope className="w-4 h-4" />
            Sick
          </button>
          <button
            disabled={submit.isPending}
            onClick={() => mark("no_show")}
            className={`${btn} border-destructive/50 text-destructive hover:bg-destructive/10`}
          >
            <UserX className="w-4 h-4" />
            No-show
          </button>
          <button
            disabled={submit.isPending}
            onClick={() => mark("excused")}
            className={`${btn} border-victory/50 text-victory hover:bg-victory/10`}
          >
            <CalendarOff className="w-4 h-4" />
            Excused
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
