import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { actionActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Fetch an action by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Action retrieved", data: getEngineApi().getAction(id) };
  },
);

/** Apply an action action: cancel / retry / archive / restore / delete. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(actionActionSchema, await req.json());
    const api = getEngineApi();

    let data: unknown;
    switch (body.action) {
      case "cancel":
        data = api.cancelAction(id, body.now);
        break;
      case "retry":
        data = api.retryAction(id);
        break;
      case "archive":
        data = api.archiveAction(id);
        break;
      case "restore":
        data = api.restoreAction(id);
        break;
      case "delete":
        api.deleteAction(id);
        data = { id };
        break;
      default:
        throw new ValidationError(`Unknown action "${body.action}"`);
    }
    return { message: `Action ${body.action} applied`, data };
  },
);

/** Delete an action entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().deleteAction(id);
    return { message: "Action deleted", data: { id } };
  },
);
