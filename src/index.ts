import type { FastifyBaseLogger } from 'fastify';
import { HttpAuraConnector } from './aura/http.js';
import { SimAuraConnector } from './aura/sim.js';
import { configFromEnv } from './config.js';
import { createLogger } from './logger.js';
import { InvestigationEngine } from './control/engine.js';
import { IncidentStore } from './control/store.js';
import { ConsoleSlack, RealSlack, type SlackPort } from './outbound/slack.js';
import { startSlackTrigger, type StartedSlackTrigger } from './triggers/slack.js';
import { buildServer } from './server.js';

const config = configFromEnv();
const logger = createLogger('aura-bridge') as unknown as FastifyBaseLogger;

const store = new IncidentStore(config.stateFile);
store.load();

let slack: SlackPort;
if (config.slackMode === 'real') {
  if (!config.slackBotToken) {
    logger.error('SLACK_MODE=real requires SLACK_BOT_TOKEN');
    process.exit(1);
  }
  const { WebClient } = await import('@slack/web-api');
  slack = new RealSlack(new WebClient(config.slackBotToken));
} else {
  slack = new ConsoleSlack(logger);
}

const sim = new SimAuraConnector(config.simStepMs);
const real = new HttpAuraConnector(config.auraUrl);
let auraMode = config.auraMode;

const engine = new InvestigationEngine({
  store,
  slack,
  connector: () => (auraMode === 'real' ? real : sim),
  logger,
  statusUpdateIntervalMs: config.statusUpdateIntervalMs,
  channelNamePattern: config.channelNamePattern,
  channelResolve: { attempts: config.channelResolveAttempts, delayMs: config.channelResolveDelayMs },
});

const app = buildServer({
  loggerInstance: logger,
  engine,
  pdWebhookSecret: config.pdWebhookSecret,
  pdWebhookToken: config.pdWebhookToken,
  admin: {
    slack,
    getAuraMode: () => auraMode,
    setAuraMode: (mode) => {
      auraMode = mode;
      logger.info({ auraMode }, 'aura mode changed');
    },
  },
});

let slackTrigger: StartedSlackTrigger | undefined;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await slackTrigger?.stop();
    await app.close();
    store.saveNow();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  if (config.slackMode === 'real' && config.slackBotToken && config.slackAppToken) {
    slackTrigger = await startSlackTrigger({
      engine,
      logger,
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
    });
  } else {
    logger.info({ slackMode: config.slackMode }, 'slack trigger not started (console mode or missing tokens)');
  }
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}
