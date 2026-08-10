import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { startConversationSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List conversations (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Conversations retrieved", data: getEngineApi().listConversations() };
});

/** Start a conversation. */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(startConversationSchema, await req.json());
  return { message: "Conversation started", data: getEngineApi().startConversation(body) };
});
