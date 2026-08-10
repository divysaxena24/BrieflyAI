import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { buildDigestSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** List digests (insertion order). */
export const GET = withHandler(async () => {
  await requireAppUserId();
  return { message: "Digests retrieved", data: getEngineApi().listDigests() };
});

/** Build (and store) a digest for the authenticated user. */
export const POST = withHandler(async (req: Request) => {
  const userId = await requireAppUserId();
  const body = validateSchema(buildDigestSchema, await req.json());
  const digest = await getEngineApi().buildDigest(body.kind ?? "morning", {
    userId,
    ...(body.query !== undefined ? { query: body.query } : {}),
    ...(body.now !== undefined ? { now: body.now } : {}),
  });
  return { message: "Digest built", data: digest };
});
