import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLeadSourceName } from "@/lib/lead-sources";
import { LIMITED_CREATABLE_ROLES, type AppRole } from "@/lib/role-policy";
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
  return { supabaseAdmin, profile, callerIsOwner, targetRoles };
}

const targetSchema = z.object({ user_id: z.string().uuid() });

export type InviteTarget = {
  display_name: string | null;
  has_auth: boolean;
  /** Board-minted profile with no login behind it — inviting one creates the
   *  login and absorbs the placeholder's history into it. */
  is_placeholder: boolean;
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
      is_placeholder: !!profile.is_placeholder,
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

/** Generate a one-time sign-in link. Nothing is emailed by the server — the
 *  manager copies the link and texts/emails it themselves. The link signs
 *  the person in once and lands them on /auth/welcome to set their own
 *  password; their role (set on this same page) decides what they see.
 *
 *  Placeholder profiles (board-minted, no auth account) are invitable too:
 *  the handler creates the login with the entered email, copies the
 *  placeholder's profile state onto it, carries its role over, and runs
 *  merge_canvassers so every log, lead, pin, and alias follows — then hands
 *  back the link. Same person, new login, history intact. */
export const createInviteLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createInviteSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabaseAdmin, profile, callerIsOwner, targetRoles } = await assertInviteAllowed(
      context,
      data.user_id,
    );

    const { data: found, error: getErr } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    if (getErr || !found?.user) {
      // is_placeholder is the ground truth for "create the login" — a
      // transient lookup failure on an auth-backed row must NOT take the
      // create path (creating + merging would absorb their real account).
      if (!profile.is_placeholder) {
        throw new Error("Couldn't find the login behind this player — try again.");
      }
      return inviteAsNewLogin(context, data, { callerIsOwner, targetRoles });
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

    return { link, email, user_id: data.user_id };
  });

/** The placeholder path of createInviteLink: mint the login, move the
 *  placeholder's identity onto it, return the sign-in link. On any failure
 *  before the merge lands, the fresh login is torn down so the roster is
 *  exactly as it was. */
async function inviteAsNewLogin(
  context: AdminCtx,
  data: { user_id: string; email?: string },
  caller: { callerIsOwner: boolean; targetRoles: string[] },
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const placeholderId = data.user_id;

  const email = data.email;
  if (!email) {
    throw new Error("No login behind this player yet — enter their email to create one.");
  }
  if (SYNTHETIC_EMAIL_RE.test(email)) {
    throw new Error("That's a placeholder import address — enter their real email.");
  }
  // Minting a login at a tier is creating an account at that tier, so the
  // Add Player rule applies: non-owners only at the canvasser tier.
  if (
    !caller.callerIsOwner &&
    caller.targetRoles.some((r) => !LIMITED_CREATABLE_ROLES.includes(r as AppRole))
  ) {
    throw new Error(
      "Only Owners can invite players above the Canvasser / Sales Rep tier — ask an Owner to send this one.",
    );
  }

  // Full placeholder row up front — profile state (team, office, XP, rank,
  // pay-lock, Joined date) rides over onto the new login's profile, which
  // handle_new_user creates bare.
  const { data: ph, error: phErr } = await supabaseAdmin
    .from("profiles")
    .select("*")
    .eq("id", placeholderId)
    .single();
  if (phErr || !ph) throw new Error("Player not found.");

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    // Throwaway — never shown to anyone; they set their own on /auth/welcome.
    password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
    email_confirm: true,
    user_metadata: { display_name: ph.display_name },
  });
  if (createErr) {
    throw new Error(
      /already|exists|registered/i.test(createErr.message)
        ? `${email} already has an account — invite that player's row instead, or Combine the two rows first.`
        : createErr.message,
    );
  }
  const newUserId = created.user?.id;
  if (!newUserId) throw new Error("Failed to create the login — try again.");

  try {
    const { id: _id, is_placeholder: _ph, is_active: _ia, updated_at: _ua, ...carry } = ph;
    const { error: copyErr } = await supabaseAdmin
      .from("profiles")
      .update(carry)
      .eq("id", newUserId);
    if (copyErr) throw new Error(copyErr.message);

    // The placeholder's role beats the trigger's default canvasser (merge
    // deliberately drops loser roles, so carry them before merging).
    const roles = caller.targetRoles as AppRole[];
    if (roles.length && !(roles.length === 1 && roles[0] === "canvasser")) {
      const { error: delErr } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", newUserId);
      if (delErr) throw new Error(delErr.message);
      const { error: insErr } = await supabaseAdmin
        .from("user_roles")
        .insert(roles.map((role) => ({ user_id: newUserId, role })));
      if (insErr) throw new Error(insErr.message);
    }

    // merge_canvassers runs as the CALLER, not the service client — it reads
    // auth.uid() for its permission checks and would refuse a NULL caller.
    // Names already match, so no rename happens; history, pins, and aliases
    // move, and the placeholder row is deleted.
    const { error: mergeErr } = await context.supabase.rpc("merge_canvassers", {
      _loser_ids: [placeholderId],
      _keeper: newUserId,
    });
    if (mergeErr) throw new Error(mergeErr.message);
  } catch (e) {
    // Tear the fresh login down (roles → profile → auth user, matching the
    // FK graph); the placeholder is untouched until the merge commits.
    await supabaseAdmin.from("user_roles").delete().eq("user_id", newUserId);
    await supabaseAdmin.from("profiles").delete().eq("id", newUserId);
    await supabaseAdmin.auth.admin.deleteUser(newUserId).catch(() => {});
    throw e instanceof Error ? e : new Error(String(e));
  }

  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo: `${APP_ORIGIN}${WELCOME_PATH}` },
  });
  if (linkErr || !linkData?.properties?.action_link) {
    // The login + merge already landed — don't roll back history. Their row
    // is now auth-backed, so a retry goes down the normal path.
    throw new Error(
      "Their login was created with all history attached, but the link didn't come back — hit Invite on their row again to generate it.",
    );
  }

  return { link: linkData.properties.action_link, email, user_id: newUserId };
}
