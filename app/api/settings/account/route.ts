import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { deleteAccount } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

/** Delete the account and all associated data (preferences, integrations, activity). */
export const DELETE = withHandler(async () => {
  const userId = await requireAppUserId();
  await deleteAccount(userId);
  return { message: "Account deleted", data: { deleted: true } };
});
