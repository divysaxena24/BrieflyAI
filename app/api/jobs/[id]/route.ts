import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { jobActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Fetch a job by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Job retrieved", data: getEngineApi().getJob(id) };
  },
);

/** Apply a job action: run / cancel / retry / archive / restore / unregister. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(jobActionSchema, await req.json());
    const api = getEngineApi();

    let data: unknown;
    switch (body.action) {
      case "run":
        data = await api.runJob(id, body.now);
        break;
      case "cancel":
        data = api.cancelJob(id, body.now);
        break;
      case "retry":
        data = api.retryJob(id);
        break;
      case "archive":
        data = api.archiveJob(id);
        break;
      case "restore":
        data = api.restoreJob(id);
        break;
      case "unregister":
        api.unregisterJob(id);
        data = { id };
        break;
      default:
        throw new ValidationError(`Unknown job action "${body.action}"`);
    }
    return { message: `Job ${body.action} applied`, data };
  },
);

/** Unregister (remove) a job entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().unregisterJob(id);
    return { message: "Job unregistered", data: { id } };
  },
);
