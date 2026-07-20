import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@insforge/sdk/ssr/middleware";

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  // Cast cookies to the expected CookieStore interface
  // Both RequestCookies and ResponseCookies have the required get/set/delete methods
  await updateSession({
    requestCookies: request.cookies as unknown as Parameters<typeof updateSession>[0]["requestCookies"],
    responseCookies: response.cookies as unknown as Parameters<typeof updateSession>[0]["responseCookies"],
  });

  return response;
}
