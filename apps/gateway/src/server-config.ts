/**
 * Server-level policy configuration.
 * Edit these values to change platform-wide behaviour.
 */
export const serverConfig = {
  /**
   * Maximum number of active (non-ended) sessions a single user account can
   * hold simultaneously, across all campaigns.
   * Set to 0 to disable the limit.
   */
  maxActiveSessions: 3,

  /**
   * When false, regular accounts cannot create new campaigns.
   * Useful when you want only admins / a seeded set of campaigns to exist.
   */
  canBasicAccountCreateCampaigns: true,

  /**
   * How many session events must accumulate before the Architect chronicler
   * runs a full analysis pass (lore deduplication, milestone detection,
   * session archive compression).
   * Lower values = more frequent but more LLM calls. Set to 0 to disable
   * the periodic trigger (chronicler will still run at session end).
   */
  chroniclerEventInterval: 20,
} as const;
