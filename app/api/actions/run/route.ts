import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { runActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Execute a single action through the Action Engine (never throws). */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(runActionSchema, await req.json());
  const { result } = await getEngineApi().runAction(body);
  return { message: "Action executed", data: result };
});
