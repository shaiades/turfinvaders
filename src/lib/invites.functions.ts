import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLeadSourceName } from "@/lib/lead-sources";
import { z } from "zod";

/** Invite links always point at production — local dev shares the prod
 *  Supabase, and an invite generated from a dev session must still land the
 *  invitee on the real app. https://turfinvaders.com/** is on the auth
 *  redirect allowlist (verified 2026-09-09). */
const APP_ORIGIN = "https://turfinvaders.com";
const WELCOME_PATH = "/auth/welcome";

/** The CSV import (2026-06-30) minted auth users with synthetic
 *  csv-import+…@knockout.local addresses. Nobody can receive mail there, so
 *  an invite for one of these accounts must supply the person's real email. */
const SYNTHETIC_EMAIL_RE = /@knockout\.local$/i;

type AdminCtx = { supabase: SupabaseClient; userId: string };

/** Invite is an Admin-tier action (the Manage Players page's tier), and only
 *  Owners may act on privileged (Owner/Admin) targets — an invite link IS
 *  credentials for the target account. */
async function assertInviteAllowed(context: AdminCtx, targetUserId: string) {
  const { data: callerRows, error: callerErr } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (callerErr) throw new Error(callerErr.message);
  const callerRoles = (callerRows ?? []).map((r: { role: string }) => r.role);
  const callerIsOwner = callerRoles.includes("owner");
  if (!callerIsOwner && !callerRoles.includes("office_staff")) {
    throw new Error("Only Owners and Admins can invite players.");
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [{ data: targetRows, error: targetErr }, { data: profile, error: profErr }] =
    await Promise.all([
      supabaseAdmin.from("user_roles").select("role").eq("user_id", targetUserId),
      supabaseAdmin
        .from("profiles")
        .select("display_name, is_placeholder")
        .eq("id", targetUserId)
        .maybeSingle(),
    ]);
  if (targetErr) throw new Error(targetErr.message);
  if (profErr) throw new Error(profErr.message);
  if (!profile) throw new Error("Player not found.");
  if (isLeadSourceName(profile.display_name)) {
    throw new Error("Lead-source channels are not people and cannot be invited.");
  }
  const targetRoles = (targetRows ?? []).map((r: { role: string }) => r.role);
  const targetPrivileged = targetRoles.includes("owner") || targetRoles.includes("office_staff");
  if (targetPrivileged && !callerIsOwner) {
    throw new Error("Only Owners can invite Owner or Admin accounts.");
  }
  return { supabaseAdmin, profile };
}

const targetSchema = z.object({ user_id: z.string().uuid() });

export type InviteTarget = {
  display_name: string | null;
  has_auth: boolean;
  email: string | null;
  /** true = csv-import placeholder address that can't receive mail. */
  synthetic_email: boolean;
};

/** What the Invite dialog needs to render: does a login account exist behind
 *  this profile, and is its email real or the csv-import placeholder? */
export const getInviteTarget = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => targetSchema.parse(data))
  .handler(async ({ data, context }): Promise<InviteTarget> => {
    const { supabaseAdmin, profile } = await assertInviteAllowed(context, data.user_id);
    const { data: res } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    const email = res?.user?.email ?? null;
    return {
      display_name: profile.display_name ?? null,
      has_auth: !!res?.user,
      email,
      synthetic_email: !!email && SYNTHETIC_EMAIL_RE.test(email),
    };
  });

const createInviteSchema = z.object({
  user_id: z.string().uuid(),
  /** Real email to put on the account before generating the link. Required
   *  when the account still carries a synthetic csv-import address. */
  email: z.string().trim().toLowerCase().email().max(255).optional(),
});

/** Generate a one-time sign-in link for an EXISTING auth account. Nothing is
 *  emailed by the server — the manager copies the link and texts/emails it
 *  themselves. The link signs the person in once and lands them on
 *  /auth/welcome to set their own password; their role (set on this same
 *  page) decides what they see. Placeholder profiles have no auth account —
 *  create those people with Add Player instead. */
export const createInviteLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createInviteSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await assertInviteAllowed(context, data.user_id);

    const { data: found, error: getErr } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    if (getErr || !found?.user) {
      throw new Error(
        "No login account behind this player — placeholder profiles get accounts via Add Player.",
      );
    }
    const currentEmail: string | null = found.user.email ?? null;

    let email = currentEmail;
    if (data.email && data.email !== currentEmail?.toLowerCase()) {
      // Admin-side email change: applied directly, marked confirmed, no
      // confirmation round-trip (the current address may be undeliverable).
      const { error: updErr } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
        email: data.email,
        email_confirm: true,
      });
      if (updErr) throw new Error(`Couldn't set that email: ${updErr.message}`);
      email = data.email;
    }
    if (!email) throw new Error("This account has no email — enter one to invite them.");
    if (SYNTHETIC_EMAIL_RE.test(email)) {
      throw new Error(
        "This account still has the placeholder import email — enter their real email to invite them.",
      );
    }

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${APP_ORIGIN}${WELCOME_PATH}` },
    });
    if (linkErr) throw new Error(linkErr.message);
    const link = linkData?.properties?.action_link;
    if (!link) throw new Error("Supabase returned no link — try again.");

    return { link, email };
  });
