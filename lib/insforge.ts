import { createClient } from "@insforge/sdk";
import type { InsForgeClient } from "@insforge/sdk";

/** Create an InsForge client with the public anon key (works in browser & server) */
export function createInsForgeClient(): InsForgeClient {
  return createClient({
    baseUrl: process.env.NEXT_PUBLIC_INSFORGE_URL!,
    anonKey: process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY!,
  });
}
