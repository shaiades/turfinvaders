import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { isLeadSourceName } from "@/lib/lead-sources";
import {
  APP_ROLES,
  LIMITED_CREATABLE_ROLES,
  MANAGER_GRANTABLE_ROLES,
  type AppRole,
} from "@/lib/role-policy";
import { OFFICE_LOCATIONS } from "@/lib/offices";
import { z } from "zod";

/** Invite links always point at production — local dev shares the prod
 *  Supabase, and an invite generated from a dev session must still land the
 *  invitee on the real app. https://turfinvaders.com/** is on the auth
 *  redirect allowlist (verified 2026-09-09). */
const APP_ORIGIN = "https://turfinvaders.com";
const WELCOME_PATH = "/auth/welcome";

/** Durable invite links (owner ask 2026-11-23): the shared link carries OUR
 *  128-bit token (invite_tokens, 14 days), not a Supabase recovery hash. The
 *  welcome page exchanges it for a fresh recovery OTP only when the invitee
 *  taps ENTER (redeemInvite below), so the 1-hour OTP window starts at the
 *  tap — a link texted on Friday still works on Monday. Re-inviting
 *  supersedes older links.
 *
 *  Why our own page + a tap, not Supabase's action_link: that URL is
 *  consumed by a bare GET, so iMessage/WhatsApp/email link-preview bots were
 *  eating invites seconds after managers sent them ("the links expire
 *  instantly", 2026-09-11). /auth/welcome spends nothing until the invitee
 *  taps Enter. */
async function mintInviteToken(
  supabaseAdmin: SupabaseClient,
  userId: string,
  createdBy: string,
): Promise<{ link: string; expires_at: string }> {
  await supabaseAdmin
    .from("invite_tokens")
    .update({ superseded_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("superseded_at", null);
  const { data, error } = await supabaseAdmin
    .from("invite_tokens")
    .insert({ user_id: userId, created_by: createdBy })
    .select("token, expires_at")
    .single();
  if (error || !data) {
    throw new Error(
      /invite_tokens/.test(error?.message ?? "")
        ? "The invite-links table isn't deployed yet — apply migration 20261124150000 first."
        : (error?.message ?? "Couldn't create the invite link — try again."),
    );
  }
  return {
    link: `${APP_ORIGIN}${WELCOME_PATH}?it=${data.token}`,
    expires_at: data.expires_at,
  };
}

/** The CSV import (2026-06-30) minted auth users with synthetic
 *  csv-import+…@knockout.local addresses. Nobody can receive mail there, so
 *  an invite for one of these accounts must supply the person's real email. */
const SYNTHETIC_EMAIL_RE = /@knockout\.local$/i;

type AdminCtx = { supabase: SupabaseClient; userId: string };

/** Inviting is a manager action — Owners, Admins, and Captains (2026-09-11
 *  owner ask: captains send invites too). An invite link IS credentials for
 *  the target account, so the tiers ladder: only Owners act on privileged
 *  (Owner/Admin) targets, and Captains only on canvasser-tier targets — the
 *  same tier they may create (createCanvasser rule). */
async function assertInviteAllowed(context: AdminCtx, targetUserId: string) {
  const { data: callerRows, error: callerErr } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (callerErr) throw new Error(callerErr.message);
  const callerRoles = (callerRows ?? []).map((r: { role: string }) => r.role);
  const callerIsOwner = callerRoles.includes("owner");
  const callerIsAdmin = callerRoles.includes("office_staff");
  if (!callerIsOwner && !callerIsAdmin && !callerRoles.includes("captain")) {
    throw new Error("Only Owners, Admins, and Captains can invite players.");
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
  if (
    !callerIsOwner &&
    !callerIsAdmin &&
    targetRoles.some((r) => !LIMITED_CREATABLE_ROLES.includes(r as AppRole))
  ) {
    throw new Error(
      "Captains can invite Canvassers and Sales Reps — ask an Owner or Admin for this player.",
    );
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

    // Durable 14-day link; the recovery OTP is minted when THEY tap Enter.
    const minted = await mintInviteToken(supabaseAdmin, data.user_id, context.userId);
    return { link: minted.link, expires_at: minted.expires_at, email, user_id: data.user_id };
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

  let minted: { link: string; expires_at: string };
  try {
    minted = await mintInviteToken(supabaseAdmin, newUserId, context.userId);
  } catch {
    // The login + merge already landed — don't roll back history. Their row
    // is now auth-backed, so a retry goes down the normal path.
    throw new Error(
      "Their login was created with all history attached, but the link didn't come back — hit Invite on their row again to generate it.",
    );
  }

  return { link: minted.link, expires_at: minted.expires_at, email, user_id: newUserId };
}

/* ═══════════════ One-step add person (owner ask 2026-11-23) ═══════════════ */

/** Server twin of creatableRolesFor — same rule as users.functions.ts. */
function roleCreatableBy(callerRoles: string[], role: AppRole): boolean {
  if (callerRoles.includes("owner")) return true;
  if (callerRoles.includes("office_staff")) return MANAGER_GRANTABLE_ROLES.includes(role);
  if (callerRoles.includes("captain")) return LIMITED_CREATABLE_ROLES.includes(role);
  return false;
}

const createPersonSchema = z.object({
  display_name: z.string().trim().min(1).max(100),
  role: z.enum(APP_ROLES as unknown as [AppRole, ...AppRole[]]),
  office_location: z.enum(OFFICE_LOCATIONS).optional(),
  team_id: z.string().uuid().nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(255),
});

/** THE one-step add: name + role + email in, a working invite link out.
 *  Creates the login (throwaway password — they set their own on
 *  /auth/welcome), places the profile, sets the role, and mints a durable
 *  14-day invite link, all in one call. Replaces the old two-step Add
 *  Player → Invite dance. */
export const createPersonWithInvite = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createPersonSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const callerRoles = (roleRows ?? []).map((r) => r.role as string);
    if (
      !callerRoles.includes("owner") &&
      !callerRoles.includes("office_staff") &&
      !callerRoles.includes("captain")
    ) {
      throw new Error("Only Owners, Managers, or Captains can add new people.");
    }
    if (!roleCreatableBy(callerRoles, data.role)) {
      throw new Error("Your role can't create accounts at that tier.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      // Throwaway — never shown to anyone; they set their own on /auth/welcome.
      password: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (createErr) {
      throw new Error(
        /already|exists|registered/i.test(createErr.message)
          ? `${data.email} already has an account — use Invite on their existing row instead.`
          : createErr.message,
      );
    }
    const newUserId = created.user?.id;
    if (!newUserId) throw new Error("Failed to create the login — try again.");

    // handle_new_user made a bare profile; place them.
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .update({
        display_name: data.display_name,
        team_id: data.team_id ?? null,
        ...(data.office_location ? { office_location: data.office_location } : {}),
      })
      .eq("id", newUserId);
    if (profErr) throw new Error(profErr.message);

    // The chosen role beats the trigger's default.
    if (data.role !== "canvasser") {
      const { error: delErr } = await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", newUserId);
      if (delErr) throw new Error(delErr.message);
      const { error: insErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: newUserId, role: data.role });
      if (insErr) throw new Error(insErr.message);
    }

    const minted = await mintInviteToken(supabaseAdmin, newUserId, context.userId);
    return { user_id: newUserId, link: minted.link, expires_at: minted.expires_at };
  });

const redeemSchema = z.object({ token: z.string().regex(/^[0-9a-f]{32}$/) });

/** The welcome page's exchange: durable ?it= token in, fresh recovery OTP
 *  hash out. Unauthenticated by design — the invitee has no session yet; the
 *  128-bit token IS the credential, exactly like the old recovery-hash link.
 *  A redeemed token stays exchangeable for 1 hour (double-taps, a failed
 *  verify, a reload), then reads as used. */
export const redeemInvite = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => redeemSchema.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("invite_tokens")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (error) throw new Error("Couldn't check that invite — try again.");
    if (!row) throw new Error("invalid");
    if (row.superseded_at) throw new Error("superseded");
    if (new Date(row.expires_at).getTime() < Date.now()) throw new Error("expired");
    if (row.used_at && Date.now() - new Date(row.used_at).getTime() > 60 * 60 * 1000) {
      throw new Error("used");
    }

    const { data: userRes } = await supabaseAdmin.auth.admin.getUserById(row.user_id);
    const email = userRes?.user?.email;
    if (!email) throw new Error("invalid");

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: `${APP_ORIGIN}${WELCOME_PATH}` },
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      throw new Error("Couldn't start sign-in — tap the link again.");
    }
    if (!row.used_at) {
      await supabaseAdmin
        .from("invite_tokens")
        .update({ used_at: new Date().toISOString() })
        .eq("id", row.id);
    }
    return { th: linkData.properties.hashed_token };
  });
