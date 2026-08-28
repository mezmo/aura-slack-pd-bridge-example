import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerAdminRoutes, type AdminDeps } from './admin/routes.js';
import type { InvestigationEngine } from './control/engine.js';
import { registerPagerDutyTrigger } from './triggers/pagerduty.js';

export interface ServerDeps {
  loggerInstance: FastifyBaseLogger;
  engine: InvestigationEngine;
  pdWebhookSecret?: string;
  pdWebhookToken?: string;
  admin: Omit<AdminDeps, 'engine'>;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ loggerInstance: deps.loggerInstance });

  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (statusCode >= 400 && statusCode < 500) {
      void reply.status(statusCode).send({
        error: { code: 'invalid_request', message: (error as Error).message },
      });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    void reply.status(500).send({
      error: { code: 'upstream_error', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: { code: 'not_found', message: `No route ${request.method} ${request.url}` },
    });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));
  // Stateless: ready as soon as we're serving.
  app.get('/readyz', async () => ({ status: 'ready' }));

  registerPagerDutyTrigger(app, {
    engine: deps.engine,
    secret: deps.pdWebhookSecret,
    sharedToken: deps.pdWebhookToken,
  });
  registerAdminRoutes(app, { engine: deps.engine, ...deps.admin });

  return app;
}
