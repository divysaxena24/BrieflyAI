import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { planIntentSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List stored actions (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Actions retrieved", data: getEngineApi().listActions() };
});

/** Plan an intent into an immutable action plan (nothing is executed). */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(planIntentSchema, await req.json());
  return { message: "Action plan created", data: getEngineApi().plan(body) };
});
