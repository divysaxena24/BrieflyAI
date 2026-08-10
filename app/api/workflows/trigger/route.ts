import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, triggerEventFromWire } from "@/lib/api/resources";
import { triggerWorkflowSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Fire a workflow trigger event: run every matching stored workflow. */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(triggerWorkflowSchema, await req.json());
  const summary = await getEngineApi().triggerWorkflow(triggerEventFromWire(body));
  return { message: "Workflow trigger fired", data: summary };
});
