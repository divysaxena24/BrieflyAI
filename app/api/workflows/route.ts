import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, workflowFromWire } from "@/lib/api/resources";
import { registerWorkflowSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List registered workflows (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Workflows retrieved", data: getEngineApi().listWorkflows() };
});

/** Register a workflow (steps validated by the model's `createWorkflow`). */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(registerWorkflowSchema, await req.json());
  const workflow = getEngineApi().registerWorkflow(workflowFromWire(body));
  return { message: "Workflow registered", data: workflow };
});
