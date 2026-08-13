export {
  findUserByAuthId,
  findUserById,
  findUserByEmail,
  createUser,
  updateUser,
} from "./users";
export type { CreateUserInput } from "./users";

export {
  getUserIntegrations,
  getIntegrationById,
  getUserIntegrationByPlatform,
  getConnectedAccount,
  createIntegration,
  updateIntegrationStatus,
  deleteIntegration,
} from "./integrations";
export type { CreateIntegrationInput, ConnectedAccount } from "./integrations";

export {
  logActivity,
  getActivityLogs,
} from "./activity";
export type { LogActivityInput, ActivityLogEntry } from "./activity";

export {
  getUserPreferences,
  upsertUserPreferences,
} from "./userPreferences";
export type { UpsertUserPreferencesInput } from "./userPreferences";
