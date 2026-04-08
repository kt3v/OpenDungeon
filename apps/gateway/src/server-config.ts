/**
 * Server-level policy configuration.
 * Edit these values to change platform-wide behaviour.
 */
const envFlag = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return fallback;
};

export const serverConfig = {
  enableContextRouter: envFlag("ENABLE_CONTEXT_ROUTER", false),
  enableTurnLoreExtraction: envFlag("ENABLE_TURN_LORE_EXTRACTION", false),
  enableChronicler: envFlag("ENABLE_CHRONICLER", true),
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
  canBasicAccountCreateCampaigns: envFlag("CAN_BASIC_ACCOUNT_CREATE_CAMPAIGNS", true),

  /**
   * How many session events must accumulate before the Architect chronicler
   * runs a full analysis pass (lore deduplication, milestone detection,
   * session archive compression).
   * Lower values = more frequent but more LLM calls. Set to 0 to disable
   * the periodic trigger (chronicler will still run at session end).
   */
  chroniclerEventInterval: 20,

  /**
   * How often to log LLM metrics (queue depth, latency, circuit breaker state).
   * Set to 0 to disable periodic logging.
   */
  llmMetricsLogIntervalMs: 30000, // 30 seconds
} as const;
