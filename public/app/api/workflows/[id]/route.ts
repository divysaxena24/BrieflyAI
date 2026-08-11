import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { workflowActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";
import { ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Fetch a workflow by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Workflow retrieved", data: getEngineApi().getWorkflow(id) };
  },
);

/** Apply a workflow action: run / disable / enable / archive / restore / delete. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(workflowActionSchema, await req.json());
    const api = getEngineApi();

    let data: unknown;
    switch (body.action) {
      case "run":
        data = await api.runWorkflowById(id);
        break;
      case "disable":
        data = api.disableWorkflow(id);
        break;
      case "enable":
        data = api.enableWorkflow(id);
        break;
      case "archive":
        data = api.archiveWorkflow(id);
        break;
      case "restore":
        data = api.restoreWorkflow(id);
        break;
      case "delete":
        api.deleteWorkflow(id);
        data = { id };
        break;
      default:
        throw new ValidationError(`Unknown workflow action "${body.action}"`);
    }
    return { message: `Workflow ${body.action} applied`, data };
  },
);

/** Delete a workflow entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().deleteWorkflow(id);
    return { message: "Workflow deleted", data: { id } };
  },
);
