import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { memoryPatchSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Fetch a memory by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Memory retrieved", data: getEngineApi().getMemory(id) };
  },
);

/** Update (patch) a memory. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(memoryPatchSchema, await req.json());
    return { message: "Memory updated", data: getEngineApi().updateMemory(id, body) };
  },
);

/** Delete a memory entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().deleteMemory(id);
    return { message: "Memory deleted", data: { id } };
  },
);
