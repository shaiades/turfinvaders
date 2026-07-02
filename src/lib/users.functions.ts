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
    // Owner-only.
    const { data: ownerRows, error: ownerErr } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .eq("role", "owner");
    if (ownerErr) throw new Error(ownerErr.message);
    if (!ownerRows || ownerRows.length === 0) {
      throw new Error("Only Owners can add new users.");
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
        office_location: data.office_location ?? null,
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
