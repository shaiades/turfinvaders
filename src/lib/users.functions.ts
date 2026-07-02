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
  role: z.enum(["owner", "captain", "canvasser"]),
});

/** Managers (Owner / Captain / Admin) can add a placeholder profile with a generated UUID. */
export const addTeamMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => addTeamMemberSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roleRows, error: roleErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    if (roleErr) throw new Error(roleErr.message);
    const roles = (roleRows ?? []).map((r) => r.role as string);
    const isOwner = roles.includes("owner");
    const isManager = isOwner || roles.includes("captain") || roles.includes("office_staff");
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

    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newId, role: data.role });
    if (roleErr) throw new Error(roleErr.message);

    return { id: newId };
  });
