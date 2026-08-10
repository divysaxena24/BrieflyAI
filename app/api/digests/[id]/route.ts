import { withHandler } from "@/lib/api/handler";
import { requireAppUserId } from "@/lib/api/auth";
import { getEngineApi, routeId } from "@/lib/api/resources";
import { digestActionSchema } from "@/lib/validators/engines";
import { validateSchema } from "@/lib/validators";

export const dynamic = "force-dynamic";

/** Fetch a digest by id. */
export const GET = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    return { message: "Digest retrieved", data: getEngineApi().getDigest(id) };
  },
);

/** Apply a digest action: publish / read / unread / archive / restore / delete. */
export const PUT = withHandler(
  async (req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    const body = validateSchema(digestActionSchema, await req.json());
    const api = getEngineApi();

    let data: unknown;
    switch (body.action) {
      case "publish":
        data = api.publishDigest(id, body.now);
        break;
      case "read":
        data = api.markDigestRead(id, body.now);
        break;
      case "unread":
        data = api.markDigestUnread(id, body.now);
        break;
      case "archive":
        data = api.archiveDigest(id, body.now);
        break;
      case "restore":
        data = api.restoreDigest(id, body.now);
        break;
      case "delete":
        api.deleteDigest(id, body.now);
        data = { id };
        break;
    }
    return { message: `Digest ${body.action} applied`, data };
  },
);

/** Delete a digest entirely. */
export const DELETE = withHandler(
  async (_req: Request, context: unknown) => {
    await requireAppUserId();
    const id = await routeId(context);
    getEngineApi().deleteDigest(id);
    return { message: "Digest deleted", data: { id } };
  },
);
