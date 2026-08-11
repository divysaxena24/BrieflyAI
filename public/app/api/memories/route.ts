import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { createMemorySchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List stored memories (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Memories retrieved", data: getEngineApi().listMemories() };
});

/** Create a memory. */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(createMemorySchema, await req.json());
  return { message: "Memory created", data: getEngineApi().createMemory(body) };
});
