import { DefaultProvider } from "./defaultProvider";
import { normalizeProviderId, getProviderDisplayName } from "./utils";
import type { Provider } from "./types";
import { logger } from "@/lib/logger";

const providers = new Map<string, Provider>();

/**
 * Register a provider implementation with the registry.
 * Call during explicit bootstrapping.
 */
export function registerProvider(id: string, provider: Provider) {
  const key = normalizeProviderId(id);
  providers.set(key, provider);
  logger.debug("Provider registered", { provider: key });
}

/**
 * Get a provider by id. If no provider is registered, return a default stub.
 * This keeps orchestrator logic independent from concrete provider implementations.
 */
export function getProvider(id: string): Provider {
  const key = normalizeProviderId(id);
  if (providers.has(key)) return providers.get(key)!;

  // Lazy fallback to a default provider stub so orchestration can proceed.
  const fallback = new DefaultProvider(key, getProviderDisplayName(key));
  // Do NOT register the fallback permanently — keep registry explicit.
  logger.warn("No provider registered for id; using default stub", { provider: key });
  return fallback;
}

/**
 * Register placeholder providers for common integration keys.
 * This is safe to call during bootstrap.
 */
export function registerDefaultPlaceholders() {
  ["gmail", "google-calendar", "google-drive", "github", "discord", "telegram"].forEach((id) => {
    if (!providers.has(id)) {
      registerProvider(id, new DefaultProvider(id, getProviderDisplayName(id)));
    }
  });
}

/**
 * Bootstrap providers: register placeholders and optionally provider implementations.
 * This avoids import-time side effects and gives explicit control over registration.
 */
export function bootstrapProviders() {
  registerDefaultPlaceholders();

  // Register GoogleProvider if configuration present
  try {
    const Google = require("./googleProvider").GoogleProvider;
    if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI) {
      const google = new Google();
      // Register under both 'google' (primary) and 'gmail' (consumer alias) so existing UI stays functional
      registerProvider("google", google);
      registerProvider("gmail", google);
      logger.info("bootstrapProviders: GoogleProvider registered for 'google' and 'gmail'");
    }
  } catch (err) {
    logger.debug("bootstrapProviders: GoogleProvider not registered", { error: err });
  }

  // Register GitHubProvider if configuration present
  try {
    const GitHub = require("./githubProvider").GitHubProvider;
    if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.GITHUB_REDIRECT_URI) {
      const github = new GitHub();
      // Register under 'github' (overwrites the placeholder registered above)
      registerProvider("github", github);
      logger.info("bootstrapProviders: GitHubProvider registered for 'github'");
    }
  } catch (err) {
    logger.debug("bootstrapProviders: GitHubProvider not registered", { error: err });
  }

  // Register DiscordProvider if configuration present
  try {
    const Discord = require("./discordProvider").DiscordProvider;
    if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.DISCORD_REDIRECT_URI) {
      const discord = new Discord();
      // Register under 'discord' (overwrites the placeholder registered above)
      registerProvider("discord", discord);
      logger.info("bootstrapProviders: DiscordProvider registered for 'discord'");
    }
  } catch (err) {
    logger.debug("bootstrapProviders: DiscordProvider not registered", { error: err });
  }

  // Register TelegramProvider unconditionally — Telegram uses per-user Bot
  // Tokens, so unlike Google/GitHub/Discord there are no server-side
  // CLIENT_ID / CLIENT_SECRET / REDIRECT_URI credentials to gate on.
  try {
    const Telegram = require("./telegramProvider").TelegramProvider;
    // Register under 'telegram' (overwrites the placeholder registered above)
    registerProvider("telegram", new Telegram());
    logger.info("bootstrapProviders: TelegramProvider registered for 'telegram'");
  } catch (err) {
    logger.debug("bootstrapProviders: TelegramProvider not registered", { error: err });
  }

}

export function listRegisteredProviders() {
  return Array.from(providers.keys());
}

export const registry = {
  registerProvider,
  getProvider,
  registerDefaultPlaceholders,
  bootstrapProviders,
  listRegisteredProviders,
};

export default registry;