import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { conversationActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Fetch a conversation by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Conversation retrieved", data: getEngineApi().getConversation(id) };
  },
);

/** Apply a conversation action: append / rename / archive / restore / close / delete. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(conversationActionSchema, await req.json());
    const api = getEngineApi();

    let data: unknown;
    switch (body.action) {
      case "append": {
        if (body.message === undefined) throw new ValidationError("`message` required for append");
        data = api.appendMessage(id, body.message);
        break;
      }
      case "rename": {
        if (body.title === undefined) throw new ValidationError("`title` required for rename");
        data = api.renameConversation(id, body.title);
        break;
      }
      case "archive":
        data = api.archiveConversation(id);
        break;
      case "restore":
        data = api.restoreConversation(id);
        break;
      case "close":
        data = api.closeConversation(id);
        break;
      case "delete":
        api.deleteConversation(id);
        data = { id };
        break;
    }
    return { message: `Conversation ${body.action} applied`, data };
  },
);

/** Delete a conversation entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().deleteConversation(id);
    return { message: "Conversation deleted", data: { id } };
  },
);
