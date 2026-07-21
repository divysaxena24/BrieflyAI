import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/utils/supabase/server";
import { saveUserToDatabase } from "@/lib/auth";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/dashboard";

  if (code) {
    const cookieStore = await cookies();
    const supabase = createClient(cookieStore);

    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error && data?.user) {
      const meta = data.user.user_metadata ?? {};

      // Save the user to the custom users table with Google as provider
      await saveUserToDatabase({
        authUserId: data.user.id,
        fullName:
          (meta.full_name as string) ??
          (meta.name as string) ??
          data.user.email?.split("@")[0] ??
          "User",
        email: data.user.email ?? "",
        avatarUrl: (meta.avatar_url as string) ?? (meta.picture as string) ?? null,
        provider: "google",
      });

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Redirect to sign-in with an error if the code exchange failed
  return NextResponse.redirect(`${origin}/sign-in?error=auth_code_error`);
}
