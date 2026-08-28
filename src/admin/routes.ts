// Admin API for the TUI and hands-on testing. Exercises each layer without the
// one above it: fake PD incident (no PagerDuty), fake mention (no Slack app),
// test messages/approvals (no aura), live real/sim toggle. Never routed by the
// ingress — reachable only in-cluster or via port-forward.
import type { FastifyInstance } from 'fastify';
import type { InvestigationEngine } from '../control/engine.js';
import { approvalBlocks, type SlackPort } from '../outbound/slack.js';

export interface AdminDeps {
  engine: InvestigationEngine;
  slack: SlackPort;
  getAuraMode: () => 'real' | 'sim';
  setAuraMode: (mode: 'real' | 'sim') => void;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  let testCounter = 0;

  app.get('/admin/status', async () => ({
    auraMode: deps.getAuraMode(),
    ...deps.engine.status(),
  }));

  app.post<{ Body: { mode?: string } }>('/admin/aura/mode', async (request, reply) => {
    const mode = request.body?.mode;
    if (mode !== 'real' && mode !== 'sim') {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'mode must be real|sim' } });
    }
    deps.setAuraMode(mode);
    return { auraMode: mode };
  });

  // Fake PD incident: same path as the real webhook, minus PagerDuty. Either
  // an explicit channelId, or an incidentNumber to exercise pattern resolution.
  app.post<{ Body: { incidentId?: string; incidentNumber?: number; channelId?: string; title?: string } }>(
    '/admin/pd-incident',
    async (request, reply) => {
      const incidentId = request.body?.incidentId ?? `FAKE-${++testCounter}`;
      const { channelId, incidentNumber } = request.body ?? {};
      if (!channelId && incidentNumber === undefined) {
        return reply
          .status(400)
          .send({ error: { code: 'invalid_request', message: 'channelId or incidentNumber required' } });
      }
      void deps.engine.handlePdIncident({
        incidentId,
        incidentNumber,
        channelId,
        title: request.body?.title ?? 'Fake incident from admin API',
      });
      return reply.status(202).send({ incidentId, channelId: channelId ?? `(pattern: ${incidentNumber})` });
    },
  );

  // Fake @mention: exercises resume/fork logic without a Slack app.
  app.post<{ Body: { channelId?: string; text?: string; threadTs?: string } }>(
    '/admin/mention',
    async (request, reply) => {
      const { channelId, text, threadTs } = request.body ?? {};
      if (!channelId || !text) {
        return reply
          .status(400)
          .send({ error: { code: 'invalid_request', message: 'channelId and text required' } });
      }
      void deps.engine.handleMention({ channelId, text, threadTs });
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  // Plain test message: verify Slack formatting/permissions without aura.
  app.post<{ Body: { channel?: string; text?: string; threadTs?: string } }>(
    '/admin/slack/post',
    async (request, reply) => {
      const { channel, text, threadTs } = request.body ?? {};
      if (!channel || !text) {
        return reply
          .status(400)
          .send({ error: { code: 'invalid_request', message: 'channel and text required' } });
      }
      return deps.slack.postMessage({ channel, text, threadTs });
    },
  );

  // Test approval buttons: real Block Kit, fake decision id — clicking answers
  // through the engine, which reports the decision as unknown/expired.
  app.post<{ Body: { channel?: string } }>('/admin/slack/approval', async (request, reply) => {
    const channel = request.body?.channel;
    if (!channel) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'channel required' } });
    }
    const decisionId = `admin-test-${++testCounter}`;
    return deps.slack.postMessage({
      channel,
      text: 'Test approval from admin API',
      blocks: approvalBlocks({
        decisionId,
        toolName: 'nodes_log',
        args: { name: 'test-node', note: 'admin API formatting test' },
      }),
    });
  });

  // Stop the incident's active run without Slack (TUI in console mode).
  app.post<{ Body: { incidentId?: string } }>('/admin/stop', async (request, reply) => {
    const incidentId = request.body?.incidentId;
    if (!incidentId) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'incidentId required' } });
    }
    const outcome = await deps.engine.handleStopAction({ incidentId, userId: 'admin-tui' });
    return { outcome };
  });

  // Answer a pending approval without Slack (TUI in console mode).
  app.post<{ Body: { decisionId?: string; approved?: boolean } }>(
    '/admin/approval/decide',
    async (request, reply) => {
      const { decisionId, approved } = request.body ?? {};
      if (!decisionId || typeof approved !== 'boolean') {
        return reply
          .status(400)
          .send({ error: { code: 'invalid_request', message: 'decisionId and approved required' } });
      }
      const outcome = await deps.engine.handleApprovalAction({
        decisionId,
        userId: 'admin-tui',
        approved,
      });
      return { outcome };
    },
  );
}
