// Bridge configuration from env. Everything defaults to a token-less local dev
// setup: simulated aura, console slack, no webhook signature enforcement.
export interface BridgeConfig {
  port: number;
  /** 'real' streams from the aura web server; 'sim' uses the built-in simulator. */
  auraMode: 'real' | 'sim';
  auraUrl: string;
  /** 'real' needs SLACK_BOT_TOKEN (+ SLACK_APP_TOKEN for Socket Mode); 'console' logs instead. */
  slackMode: 'real' | 'console';
  slackBotToken?: string;
  slackAppToken?: string;
  /** v3 webhook subscription HMAC secret (X-PagerDuty-Signature). */
  pdWebhookSecret?: string;
  /** Shared token for workflow-sent webhooks (X-Bridge-Token). With neither
   * this nor pdWebhookSecret set, webhooks are accepted unauthenticated
   * (local dev only). */
  pdWebhookToken?: string;
  /** Unset = state is not persisted across restarts. */
  stateFile?: string;
  /** Min ms between edits of the "investigating" status message. */
  statusUpdateIntervalMs: number;
  /** Delay between simulated thinking steps. */
  simStepMs: number;
  /** Incident channel name, `{number}` = PD incident number. Must match the
   * PD incident workflow's "Create a Slack Channel" action. */
  channelNamePattern: string;
  channelResolveAttempts: number;
  channelResolveDelayMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const auraMode = env.AURA_MODE === 'real' ? 'real' : 'sim';
  const slackMode = env.SLACK_MODE === 'real' ? 'real' : 'console';
  return {
    port: Number(env.PORT ?? 3000),
    auraMode,
    auraUrl: env.AURA_URL ?? 'http://aura.aura.svc.cluster.local:8080',
    slackMode,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackAppToken: env.SLACK_APP_TOKEN,
    pdWebhookSecret: env.PD_WEBHOOK_SECRET,
    pdWebhookToken: env.PD_WEBHOOK_TOKEN,
    stateFile: env.STATE_FILE,
    statusUpdateIntervalMs: Number(env.STATUS_UPDATE_INTERVAL_MS ?? 2000),
    simStepMs: Number(env.SIM_STEP_MS ?? 1500),
    channelNamePattern: env.CHANNEL_NAME_PATTERN ?? 'incident_{number}',
    channelResolveAttempts: Number(env.CHANNEL_RESOLVE_ATTEMPTS ?? 20),
    channelResolveDelayMs: Number(env.CHANNEL_RESOLVE_DELAY_MS ?? 3000),
  };
}
