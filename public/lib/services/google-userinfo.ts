import { logger } from "@/lib/logger";

/**
 * Response shape from Google UserInfo v2 API.
 */
export interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  given_name: string;
  family_name: string;
  picture: string;
  locale: string;
}

/**
 * Fetch the user's Google account info using the access token.
 * Used during OAuth callback to store account_email, account_name, avatar_url.
 * Returns null if the request fails.
 */
export async function fetchGoogleUserInfo(
  accessToken: string
): Promise<GoogleUserInfo | null> {
  try {
    const res = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn("Google UserInfo fetch failed", {
        status: res.status,
        body,
      });
      return null;
    }

    const data: GoogleUserInfo = await res.json();
    logger.info("Google UserInfo fetched", {
      email: data.email,
      name: data.name,
    });
    return data;
  } catch (err) {
    logger.warn("Google UserInfo fetch threw", { error: String(err) });
    return null;
  }
}
