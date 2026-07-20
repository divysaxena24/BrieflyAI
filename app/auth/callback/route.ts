import { NextRequest, NextResponse } from "next/server";
import { createAuthActions } from "@insforge/sdk/ssr";

export async function GET(request: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL!;
  const code = new URL(request.url).searchParams.get("insforge_code");

  if (!code) {
    return NextResponse.redirect(new URL("/sign-in?error=no_code", baseUrl));
  }

  // Build response early so auth actions can write session cookies onto it
  const response = NextResponse.redirect(new URL("/", baseUrl));

  const codeVerifier =
    request.cookies.get("insforge_code_verifier")?.value;

  try {
    const auth = createAuthActions({
      // requestCookies only needs a .get() method
      requestCookies: {
        get: (name: string) => request.cookies.get(name)?.value ?? null,
      },
      // responseCookies needs .set() and .delete() – response.cookies provides those
      responseCookies: response.cookies,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    const { data, error } = await auth.exchangeOAuthCode(code, codeVerifier);

    if (error || !data?.user) {
      return NextResponse.redirect(
        new URL(`/sign-in?error=${error?.message ?? "auth_failed"}`, baseUrl),
      );
    }
  } catch {
    return NextResponse.redirect(
      new URL("/sign-in?error=auth_failed", baseUrl),
    );
  }

  response.cookies.delete("insforge_code_verifier");
  return response;
}
