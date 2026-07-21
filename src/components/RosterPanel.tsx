import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listRoster, type RosterRow } from "@/lib/users.functions";
import { ArcadePanel, MobileCardList, MobileCard, MobileCardHeader } from "@/components/arcade";
import { AddTeamMemberDialog } from "@/components/AddTeamMemberDialog";
import { Users } from "lucide-react";

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  office_staff: "Admin",
  captain: "Captain",
  canvasser: "Canvasser",
};

const ROLE_TONE: Record<string, string> = {
  owner: "text-victory border-victory/40",
  office_staff: "text-accent border-accent/40",
  captain: "text-neon border-neon/40",
  canvasser: "text-muted-foreground border-border",
};

export function RosterPanel() {
  const fetchRoster = useServerFn(listRoster);
  const { data, isLoading, error } = useQuery({
    queryKey: ["manage_users", "roster"],
    queryFn: () => fetchRoster(),
  });

  return (
    <ArcadePanel
      title="Active Company Roster"
      action={<AddTeamMemberDialog variant="neon" />}
    >
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-6">Loading roster…</div>
      ) : error ? (
        <div className="text-sm text-destructive py-6">{(error as Error).message}</div>
      ) : (
        <RosterTable rows={data ?? []} />
      )}
    </ArcadePanel>
  );
}

function RosterTable({ rows }: { rows: RosterRow[] }) {
  if (rows.length === 0) {
    return <div className="text-sm text-muted-foreground py-6">No players on the roster yet.</div>;
  }
  return (
    <>
      <MobileCardList>
        {rows.map((r) => {
          const isManager = r.role === "owner" || r.role === "office_staff" || r.role === "captain";
          return (
            <MobileCard key={r.id}>
              <MobileCardHeader
                left={
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate">{r.display_name}</span>
                    {r.is_placeholder && (
                      <span className="shrink-0 text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                        Placeholder
                      </span>
                    )}
                  </span>
                }
                right={
                  <span className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${ROLE_TONE[r.role] ?? ROLE_TONE.canvasser}`}>
                    {ROLE_LABEL[r.role] ?? r.role}
                  </span>
                }
              />
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{r.office_location}</span>
                {isManager && (
                  <span className="inline-flex items-center gap-1 text-victory">
                    <Users className="h-3.5 w-3.5" /> Captain / Manager
                  </span>
                )}
              </div>
            </MobileCard>
          );
        })}
      </MobileCardList>
      <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[10px] font-display uppercase tracking-widest text-muted-foreground border-b border-border">
            <th className="text-left py-2">Name</th>
            <th className="text-left py-2">Office</th>
            <th className="text-left py-2">Role</th>
            <th className="text-left py-2">Captain / Manager</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isManager = r.role === "owner" || r.role === "office_staff" || r.role === "captain";
            return (
              <tr key={r.id} className="border-b border-border/40 hover:bg-surface-elevated">
                <td className="py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.display_name}</span>
                    {r.is_placeholder && (
                      <span className="text-[9px] font-display uppercase tracking-widest px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                        Placeholder
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 text-muted-foreground">{r.office_location}</td>
                <td className="py-2.5">
                  <span className={`text-[10px] font-display uppercase tracking-widest px-2 py-1 rounded border ${ROLE_TONE[r.role] ?? ROLE_TONE.canvasser}`}>
                    {ROLE_LABEL[r.role] ?? r.role}
                  </span>
                </td>
                <td className="py-2.5">
                  {isManager ? (
                    <span className="inline-flex items-center gap-1 text-xs text-victory">
                      <Users className="h-3.5 w-3.5" /> Yes
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}
