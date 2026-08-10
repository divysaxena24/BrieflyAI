import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi } from "@/lib/api/resources";
import { persistenceActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Current engine collection sizes for the authenticated user. */
export const GET = withHandler(async () => {
  const userId = await requireAppUserId();
  return { message: "Engine state retrieved", data: { scope: userId, ...getEngineApi().stateOverview() } };
});

/** Persistence action: save / load / clear the authenticated user's scope. */
export const POST = withHandler(async (req: Request) => {
  const userId = await requireAppUserId();
  const body = validateSchema(persistenceActionSchema, await req.json());
  const api = getEngineApi();
  const scope = body.scope ?? userId;

  let data: unknown;
  switch (body.action) {
    case "save": {
      const { saved, errors } = await api.saveAll(scope);
      data = {
        scope,
        saved: saved.map((collection) => ({
          kind: collection.kind,
          version: collection.version,
          recordCount: collection.payload.length,
        })),
        errors,
      };
      break;
    }
    case "load": {
      const { errors } = await api.loadAll(scope);
      data = { scope, restored: true, errors };
      break;
    }
    case "clear": {
      await api.clearAll(scope);
      data = { scope, cleared: true };
      break;
    }
  }
  return { message: `Persistence ${body.action} applied`, data };
});
