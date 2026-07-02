import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ROLES = ["owner", "office_staff", "captain", "canvasser"] as const;

const createCanvasserSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(72),
  display_name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES).default("canvasser"),
  office_location: z.enum(["San Diego", "Orange County"]).optional(),
  team_id: z.string().uuid().nullable().optional(),
});

export const createCanvasser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => createCanvasserSchema.parse(data))
  .handler(async ({ data, context }) => {
    // Owners, Captains, and Office Staff (Admin) can add new players.
    // Captains and Office Staff can only create Canvassers or other Captains.
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r) => r.role as string);
    const isOwner = roles.includes("owner");
    const isManager = isOwner || roles.includes("captain") || roles.includes("office_staff");
    if (!isManager) {
      throw new Error("Only Owners, Captains, or Admins can add new users.");
    }
    if (!isOwner && !["canvasser", "captain"].includes(data.role)) {
      throw new Error("Only Owners can create Owners or Admins.");
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
  office_location: z.enum(["San Diego", "Orange County"]),
  role: z.enum(["owner", "office_staff", "captain", "canvasser"]),
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

/** Managers (Owner / Captain / Admin) can add a placeholder profile with a generated UUID. */
export const addTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => addTeamMemberSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { isOwner, isManager } = await assertManager(context);
    if (!isManager) throw new Error("Only Owners, Captains, or Admins can add team members.");
    if (!isOwner && !["canvasser", "captain"].includes(data.role)) {
      throw new Error("Only Owners can add Owners or Admins.");
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const newId = crypto.randomUUID();

    const { error: profErr } = await supabaseAdmin.from("profiles").insert({
      id: newId,
      display_name: data.full_name,
      office_location: data.office_location,
      is_placeholder: true,
    });
    if (profErr) throw new Error(profErr.message);

    const { error: insRoleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newId, role: data.role });
    if (insRoleErr) throw new Error(insRoleErr.message);

    return { id: newId };
  });

export type RosterRow = {
  id: string;
  display_name: string;
  office_location: string;
  role: string;
  team_name: string | null;
  is_placeholder: boolean;
};

/** Manager-only roster fetch that uses the admin client to bypass RLS. */
export const listRoster = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<RosterRow[]> => {
    const { isManager } = await assertManager(context);
    if (!isManager) throw new Error("Only managers can view the roster.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: profiles, error: pErr }, { data: roleRows, error: rErr }, { data: teams, error: tErr }] =
      await Promise.all([
        supabaseAdmin.from("profiles").select("id, display_name, office_location, team_id, is_placeholder"),
        supabaseAdmin.from("user_roles").select("user_id, role"),
        supabaseAdmin.from("teams").select("id, name"),
      ]);
    if (pErr) throw new Error(pErr.message);
    if (rErr) throw new Error(rErr.message);
    if (tErr) throw new Error(tErr.message);

    const rolePriority: Record<string, number> = { owner: 0, office_staff: 1, captain: 2, canvasser: 3 };
    const roleByUser = new Map<string, string>();
    for (const r of roleRows ?? []) {
      const prev = roleByUser.get(r.user_id);
      if (!prev || (rolePriority[r.role] ?? 9) < (rolePriority[prev] ?? 9)) {
        roleByUser.set(r.user_id, r.role);
      }
    }
    const teamById = new Map((teams ?? []).map((t) => [t.id, t.name]));

    return (profiles ?? [])
      .map((p) => ({
        id: p.id,
        display_name: p.display_name,
        office_location: p.office_location,
        role: roleByUser.get(p.id) ?? "canvasser",
        team_name: p.team_id ? teamById.get(p.team_id) ?? null : null,
        is_placeholder: p.is_placeholder,
      }))
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  });
