import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Copy, Mail, Send, Sparkles, TriangleAlert } from "lucide-react";
import { getInviteTarget, createInviteLink } from "@/lib/invites.functions";
import { NAME_KEYS } from "@/hooks/useRosterActions";
import { ROLE_LABEL, type AppRole } from "@/lib/role-policy";

/** Invite a player to the app: generates a one-time sign-in link that lands
 *  them on /auth/welcome to set a password. Auth-backed rows keep their
 *  existing account (history intact — never a second profile); placeholder
 *  rows get a login created on the spot with all their history absorbed into
 *  it. Nothing is sent automatically — the manager copies the link and
 *  texts/emails it, so the office controls exactly who gets in and with
 *  which role (set on the same Manage Players row before or after inviting). */
export function InviteDialog({
  open,
  onOpenChange,
  target,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: { id: string; name: string; role: AppRole } | null;
}) {
  const qc = useQueryClient();
  const getTarget = useServerFn(getInviteTarget);
  const createLink = useServerFn(createInviteLink);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  // Inviting a placeholder mints a NEW profile id (the login's) and deletes
  // the row the dialog opened on — "Generate a fresh link" must target the
  // id the server handed back, never the dead placeholder id.
  const [mintedId, setMintedId] = useState<string | null>(null);

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
      setMintedId(null);
    }
  }, [open, target?.id]);
  useEffect(() => {
    if (info && !info.synthetic_email && info.email) setEmail(info.email);
  }, [info]);

  const generate = useMutation({
    mutationFn: async () =>
      createLink({
        data: {
          user_id: mintedId ?? target!.id,
          email: email.trim() ? email.trim().toLowerCase() : undefined,
        },
      }),
    onSuccess: (res) => {
      setLink(res.link);
      if (res.user_id !== (mintedId ?? target?.id)) {
        // Placeholder path ran: their login now exists and the roster row
        // swapped ids — refresh everything that keys on profile ids.
        setMintedId(res.user_id);
        for (const key of NAME_KEYS) qc.invalidateQueries({ queryKey: key });
        toast.success("Login created with all history attached — copy the link and send it");
      } else {
        toast.success("Invite link ready — copy it and send it");
      }
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
  // Placeholder rows are invitable too — the server creates the login and
  // merges the placeholder into it. mintedId means that already happened.
  const willCreateLogin = !!info && !info.has_auth && info.is_placeholder && !mintedId;
  const emailRequired = needsRealEmail || willCreateLogin;
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
            Creates a one-time sign-in link — same player, all history attached. They open it, set a
            password, and land in the app as{" "}
            <span className="text-foreground font-medium">
              {target ? ROLE_LABEL[target.role] : ""}
            </span>{" "}
            (change the Role column to change what they get).
          </DialogDescription>
        </DialogHeader>

        {isLoading || !info ? (
          <div className="text-sm text-muted-foreground py-4">Checking their account…</div>
        ) : !info.has_auth && !info.is_placeholder && !mintedId ? (
          <div className="flex items-start gap-2 rounded border border-yellow-500/50 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-500">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              This row has no login account behind it. Create them with Add Player instead — then
              invite from their new row.
            </span>
          </div>
        ) : (
          <div className="space-y-3 py-1">
            {willCreateLogin && (
              <div className="flex items-start gap-2 rounded border border-[color:var(--neon-blue)]/50 bg-[color:var(--neon-blue)]/10 px-3 py-2 text-xs text-[color:var(--neon-blue)]">
                <Sparkles className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  No login yet — enter their email and this creates their account with every stat,
                  log, and pin they already have attached, then hands you the link.
                </span>
              </div>
            )}
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
                {willCreateLogin ? "Their email" : "Email on file"}
              </span>
              <Input
                type="email"
                placeholder={emailRequired ? "their.real@email.com" : (info.email ?? "")}
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
          {!!info && (info.has_auth || info.is_placeholder || !!mintedId) && (
            <Button
              onClick={() => generate.mutate()}
              disabled={generate.isPending || (emailRequired && !email.trim())}
            >
              <Send className="w-4 h-4 mr-1" />
              {generate.isPending
                ? willCreateLogin
                  ? "Creating their login…"
                  : "Generating…"
                : link
                  ? "Generate a fresh link"
                  : willCreateLogin
                    ? "Create login & invite link"
                    : "Generate invite link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
