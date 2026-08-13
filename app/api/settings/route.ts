import { z } from "zod";
import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { validateSchema } from "@/lib/validators";
import {
  getSettings,
  updatePreferences,
  updateProfile,
} from "@/lib/settings/service";

export const dynamic = "force-dynamic";

const profileSchema = z.object({
  fullName: z.string().trim().min(1, "Name is required").max(100),
});

const preferencesSchema = z
  .object({
    theme: z.enum(["light", "dark", "system"]).optional(),
    responseStyle: z.enum(["concise", "balanced", "detailed"]).optional(),
    preferredLanguage: z.enum(["english", "hindi"]).optional(),
    aiMemory: z.boolean().optional(),
    compactMode: z.boolean().optional(),
  })
  .strict();

const updateSchema = z
  .object({
    profile: profileSchema.optional(),
    preferences: preferencesSchema.optional(),
  })
  .refine((body) => body.profile !== undefined || body.preferences !== undefined, {
    message: "Nothing to update",
  });

/** Load the current user's profile + preferences. */
export const GET = withHandler(async () => {
  const userId = await requireAppUserId();
  return { message: "Settings retrieved", data: await getSettings(userId) };
});

/** Update the profile and/or preferences. */
export const PATCH = withHandler(async (request: Request) => {
  const userId = await requireAppUserId();
  const body = validateSchema(updateSchema, await request.json());

  const data: Record<string, unknown> = {};
  if (body.preferences) {
    data.preferences = await updatePreferences(userId, body.preferences);
  }
  if (body.profile) {
    data.user = await updateProfile(userId, body.profile);
  }
  return { message: "Settings updated", data };
});
