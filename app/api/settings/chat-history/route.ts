import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { clearChatHistory } from "@/lib/settings/service";

export const dynamic = "force-dynamic";

/** Clear all AI conversations for the user. */
export const DELETE = withHandler(async () => {
  await requireAppUserId();
  const deleted = await clearChatHistory();
  return { message: "Chat history cleared", data: { deleted } };
});
