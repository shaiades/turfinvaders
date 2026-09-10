import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Copy, Mail, Send, TriangleAlert } from "lucide-react";
import { getInviteTarget, createInviteLink } from "@/lib/invites.functions";
import { ROLE_LABEL, type AppRole } from "@/lib/role-policy";

/** Invite an existing player to the app: generates a one-time sign-in link
 *  for their EXISTING account (history intact — never a second profile) that
 *  lands them on /auth/welcome to set a password. Nothing is sent
 *  automatically — the manager copies the link and texts/emails it, so the
 *  office controls exactly who gets in and with which role (set on the same
 *  Manage Players row before or after inviting). */
export function InviteDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: { id: string; name: string; role: AppRole } | null;
}) {
  const getTarget = useServerFn(getInviteTarget);
  const createLink = useServerFn(createInviteLink);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const { data: info, isLoading } = useQuery({
    enabled: open && !!target,
    queryKey: ["invite_target", target?.id],
    queryFn: async () => getTarget({ data: { user_id: target!.id } }),
  });

  // Re-seed the form whenever the dialog opens on a (new) target.
  useEffect(() => {
    if (open) {
      setLink(null);
      setEmail("");
    }
  }, [open, target?.id]);
  useEffect(() => {
    if (info && !info.synthetic_email && info.email) setEmail(info.email);
  }, [info]);

  const generate = useMutation({
    mutationFn: async () =>
      createLink({
        data: {
          user_id: target!.id,
          email: email.trim() ? email.trim().toLowerCase() : undefined,
        },
      }),
    onSuccess: (res) => {
      setLink(res.link);
      toast.success("Invite link ready — copy it and send it");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success("Link copied — paste it into a text or email");
    } catch {
      toast.error("Couldn't copy automatically — select the link text and copy it");
    }
  }

  const needsRealEmail = !!info?.synthetic_email;
  const mailto = link
    ? `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(
        "Your Turf Invaders invite",
      )}&body=${encodeURIComponent(
        `Tap this link to sign in and set your password:\n\n${link}\n\nIt expires soon — open it right away.`,
      )}`
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase tracking-widest">
            Invite {target?.name ?? "player"}
          </DialogTitle>
          <DialogDescription>
            Creates a one-time sign-in link for their existing account — same player, all history
            attached. They open it, set a password, and land in the app as{" "}
            <span className="text-foreground font-medium">
              {target ? ROLE_LABEL[target.role] : ""}
            </span>{" "}
            (change the Role column to change what they get).
          </DialogDescription>
        </DialogHeader>

        {isLoading || !info ? (
          <div className="text-sm text-muted-foreground py-4">Checking their account…</div>
        ) : !info.has_auth ? (
          <div className="flex items-start gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              This is a placeholder row with no login account behind it. Create them with Add Player
              instead — then invite from their new row.
            </span>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {needsRealEmail && (
              <div className="flex items-start gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
                <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  This account still has a placeholder email from the import — enter their real
                  email to put on file before inviting.
                </span>
              </div>
            )}
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-display uppercase tracking-widest text-muted-foreground">
                Email on file
              </span>
              <Input
                type="email"
                placeholder={needsRealEmail ? "their.real@email.com" : (info.email ?? "")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>

            {link && (
              <div className="space-y-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="font-display uppercase tracking-widest text-muted-foreground">
                    Invite link · one-time, expires quickly
                  </span>
                  <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={copyLink}>
                    <Copy className="w-4 h-4 mr-1" /> Copy link
                  </Button>
                  {mailto && (
                    <Button size="sm" variant="outline" asChild>
                      <a href={mailto}>
                        <Mail className="w-4 h-4 mr-1" /> Email it
                      </a>
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Copy it into a text, or use Email it. The link signs them in once — if it expires
                  before they open it, just generate a new one.
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {info?.has_auth && (
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || (needsRealEmail && !email.trim())}
            >
              <Send className="w-4 h-4 mr-1" />
              {generate.isPending
                ? "Generating…"
                : link
                  ? "Generate a fresh link"
                  : "Generate invite link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
