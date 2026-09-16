import { createServerFn } from "@tanstack/react-start";
import { OFFICE_LOCATIONS } from "@/lib/offices";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  LIMITED_CREATABLE_ROLES,
  MANAGER_GRANTABLE_ROLES,
  type AppRole,
} from "@/lib/role-policy";
import { z } from "zod";

/** Server twin of creatableRolesFor: which starting roles this caller may
 *  hand a brand-new account. Owners: any. Managers: up to Captain (owner
 *  decision 2026-09-16). Captains: canvasser tier. */
function roleCreatable(callerRoles: string[], role: AppRole): boolean {
  if (callerRoles.includes("owner")) return true;
  if (callerRoles.includes("office_staff")) return MANAGER_GRANTABLE_ROLES.includes(role);
  if (callerRoles.includes("captain")) return LIMITED_CREATABLE_ROLES.includes(role);
  return false;
}

const ROLES = ["owner", "office_staff", "captain", "sales_rep", "confirmer", "canvasser"] as const;

const createCanvasserSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
  display_name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES).default("canvasser"),
  office_location: z.enum(OFFICE_LOCATIONS).optional(),
  team_id: z.string().uuid().nullable().optional(),
});

export const createCanvasser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createCanvasserSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Owners, Managers, and Captains can add new players; the starting role
    // is tier-capped (Managers up to Captain, Captains canvasser-tier —
    // owner decision 2026-09-16, matching set_user_role's Manager arm).
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r) => r.role as string);
    const isManager =
      roles.includes("owner") || roles.includes("captain") || roles.includes("office_staff");
    if (!isManager) {
      throw new Error("Only Owners, Managers, or Captains can add new users.");
    }
    if (!roleCreatable(roles, data.role)) {
      throw new Error("Your role can't create accounts at that tier.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Create the auth user (auto-confirmed so they can log in immediately).
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (createErr) throw new Error(createErr.message);
    const newUserId = created.user?.id;
    if (!newUserId) throw new Error("Failed to create user.");

    // handle_new_user trigger created a profile + default canvasser role.
    // Update the profile with the chosen team/office.
    const { error: profErr } = await supabaseAdmin
      .from("profiles")
      .update({
        display_name: data.display_name,
        team_id: data.team_id ?? null,
        ...(data.office_location ? { office_location: data.office_location } : {}),
      })
      .eq("id", newUserId);
    if (profErr) throw new Error(profErr.message);

    // If a non-default role was chosen, replace roles.
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

    return { id: newUserId };
  });

const addTeamMemberSchema = z.object({
  full_name: z.string().trim().min(1).max(100),
  office_location: z.enum(OFFICE_LOCATIONS),
  role: z.enum(ROLES),
  team_id: z.string().uuid().nullable().optional(),
});

async function assertManager(context: { supabase: any; userId: string }) {
  const { data: roleRows, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId);
  if (error) throw new Error(error.message);
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
  const isOwner = roles.includes("owner");
  const isManager = isOwner || roles.includes("captain") || roles.includes("office_staff");
  return { roles, isOwner, isManager };
}

/** Owner / Manager / Captain can add a placeholder profile with a generated
 *  UUID — the starting role is tier-capped like createCanvasser. */
export const addTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => addTeamMemberSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { roles, isManager } = await assertManager(context);
    if (!isManager) throw new Error("Only Owners, Managers, or Captains can add team members.");
    if (!roleCreatable(roles, data.role)) {
      throw new Error("Your role can't create accounts at that tier.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const newId = crypto.randomUUID();

    const { error: profErr } = await supabaseAdmin.from("profiles").insert({
      id: newId,
      display_name: data.full_name,
      office_location: data.office_location,
      is_placeholder: true,
      team_id: data.team_id ?? null,
    });
    if (profErr) throw new Error(profErr.message);

    const { error: insRoleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newId, role: data.role });
    if (insRoleErr) throw new Error(insRoleErr.message);

    return { id: newId };
  });

const signupRequestsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(20),
});

/** Manager-only: the role each new signup ASKED for on the auth form
 *  (requested_role in auth metadata — a claim, never a grant). Powers the
 *  "wants Canvasser / Sales Rep" chip on the New Signups panel so
 *  activation is one tap with no guessing. */
export const listSignupRequests = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => signupRequestsSchema.parse(data))
  .handler(async ({ data, context }): Promise<Record<string, string | null>> => {
    const { isManager } = await assertManager(context);
    if (!isManager) throw new Error("Only managers can view signup requests.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const entries = await Promise.all(
      data.ids.map(async (id) => {
        const { data: res } = await supabaseAdmin.auth.admin.getUserById(id);
        const requested = res?.user?.user_metadata?.requested_role;
        return [
          id,
          requested === "canvasser" || requested === "sales_rep" ? requested : null,
        ] as const;
      }),
    );
    return Object.fromEntries(entries);
  });
