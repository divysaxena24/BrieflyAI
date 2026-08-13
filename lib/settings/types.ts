/** Settings center — shared types. */

export type ThemeMode = "light" | "dark" | "system";

export type ResponseStyle = "concise" | "balanced" | "detailed";

export type PreferredLanguage = "english" | "hindi";

/** User-tunable preferences, persisted in `user_preferences`. */
export interface SettingsPreferences {
  theme: ThemeMode;
  responseStyle: ResponseStyle;
  preferredLanguage: PreferredLanguage;
  /** Remember previous conversations (AI memory). */
  aiMemory: boolean;
  compactMode: boolean;
}

/** Public profile shown in the settings center. */
export interface SettingsUser {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
  createdAt: string;
}

/** Full payload returned by GET /api/settings. */
export interface SettingsData {
  user: SettingsUser;
  plan: string;
  preferences: SettingsPreferences;
}
