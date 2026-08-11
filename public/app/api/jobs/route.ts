import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { registerJobSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List registered jobs (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Jobs retrieved", data: getEngineApi().listJobs() };
});

/** Register a background job (manual, scheduled, or recurring). */
export const POST = withHandler(async (req: Request) => {
  await requireAppUserId();
  const body = validateSchema(registerJobSchema, await req.json());
  return { message: "Job registered", data: getEngineApi().registerJob(body) };
});
