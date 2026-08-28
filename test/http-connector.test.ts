// HttpAuraConnector against a canned SSE server shaped like aura's
// /v1/chat/completions stream (chunk deltas + named aura.* events + [DONE]).
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuraEvent } from '../src/aura/connector.js';
import { HttpAuraConnector, sseFrames } from '../src/aura/http.js';

const SSE_BODY = [
  ': heartbeat',
  '',
  'event: aura.session_info',
  'data: {"session_id":"cs_1"}',
  '',
  'event: aura.progress',
  'data: {"message":"dispatching cluster_inspector"}',
  '',
  'event: aura.orchestrator.plan_created',
  'data: {"goal":"Find the leak","task_count":2,"routing_mode":"orchestrated"}',
  '',
  'event: aura.orchestrator.task_started',
  'data: {"task_id":0,"description":"Diff recent commits","worker_id":"github_analyst"}',
  '',
  'event: aura.orchestrator.worker_reasoning',
  'data: {"task_id":0,"worker_id":"github_analyst","content":"secret reasoning words"}',
  '',
  'event: aura.orchestrator.tool_call_started',
  'data: {"task_id":0,"tool_call_id":"tc1","tool_name":"SearchCode","worker_id":"github_analyst","arguments":{"order":"desc","page":1,"query":"a very long search query string"}}',
  '',
  'event: aura.orchestrator.tool_call_completed',
  'data: {"task_id":0,"tool_call_id":"tc1","success":true,"duration_ms":93}',
  '',
  'event: aura.orchestrator.task_completed',
  'data: {"task_id":0,"success":true,"duration_ms":61600,"worker_id":"github_analyst"}',
  '',
  'event: aura.orchestrator.synthesizing',
  'data: {"iteration":1}',
  '',
  'data: {"choices":[{"delta":{"content":"Root cause: "}}]}',
  '',
  'event: aura.approval_pending',
  'data: {"decision_id":"dec_1","tool_name":"nodes_log","arguments":{"name":"node-a"}}',
  '',
  'event: aura.approval_completed',
  'data: {"decision_id":"dec_1","outcome":"approved"}',
  '',
  'data: {"choices":[{"delta":{"content":"OOM in cart."}}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('sseFrames', () => {
  it('parses frames across arbitrary chunk boundaries', async () => {
    const bytes = new TextEncoder().encode(SSE_BODY);
    // 7-byte chunks split lines mid-field.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
        controller.close();
      },
    });
    const frames = [];
    for await (const frame of sseFrames(stream)) frames.push(frame);
    expect(frames).toHaveLength(14);
    expect(frames[0]).toEqual({ event: 'aura.session_info', data: '{"session_id":"cs_1"}' });
    expect(frames[9]?.event).toBeUndefined(); // the bare chat.completion.chunk
    expect(frames.at(-1)?.data).toBe('[DONE]');
  });
});

describe('HttpAuraConnector', () => {
  const app = Fastify();
  let baseUrl: string;
  let approvalBody: unknown;

  beforeAll(async () => {
    app.post('/v1/chat/completions', async (_request, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.raw.end(SSE_BODY);
    });
    app.post<{ Params: { id: string } }>('/v1/approvals/:id', async (request, reply) => {
      approvalBody = request.body;
      return reply.status(request.params.id === 'dec_1' ? 204 : 404).send();
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => app.close());

  it('maps the stream to connector events and accumulates the final text', async () => {
    const connector = new HttpAuraConnector(baseUrl);
    const events: AuraEvent[] = [];
    for await (const ev of connector.run({ sessionId: 'cs_1', messages: [{ role: 'user', content: 'go' }] })) {
      events.push(ev);
    }
    expect(events).toEqual([
      { kind: 'progress', message: 'dispatching cluster_inspector' },
      { kind: 'orchestration', update: { type: 'plan_created', goal: 'Find the leak' } },
      {
        kind: 'orchestration',
        update: { type: 'task_started', taskId: 0, workerId: 'github_analyst', description: 'Diff recent commits' },
      },
      // The reasoning fact only — payload content (the reasoning words) is dropped.
      { kind: 'orchestration', update: { type: 'worker_reasoning', taskId: 0, workerId: 'github_analyst' } },
      {
        kind: 'orchestration',
        update: {
          type: 'tool_call_started',
          taskId: 0,
          workerId: 'github_analyst',
          toolName: 'SearchCode',
          args: { order: 'desc', page: 1, query: 'a very long search query string' },
        },
      },
      // tool_call_completed intentionally dropped (no completion timings).
      { kind: 'orchestration', update: { type: 'task_completed', taskId: 0, workerId: 'github_analyst', success: true } },
      { kind: 'orchestration', update: { type: 'synthesizing' } },
      { kind: 'approval_pending', decisionId: 'dec_1', toolName: 'nodes_log', args: { name: 'node-a' } },
      { kind: 'approval_completed', decisionId: 'dec_1', outcome: 'approved' },
      { kind: 'final', text: 'Root cause: OOM in cart.' },
    ]);
  });

  it('resolves approvals with the documented payload and status codes', async () => {
    const connector = new HttpAuraConnector(baseUrl);
    expect(await connector.resolveApproval('dec_1', false, 'nope')).toBe(true);
    expect(approvalBody).toEqual({ approved: false, reason: 'nope' });
    expect(await connector.resolveApproval('unknown', true)).toBe(false);
  });

  it('yields an error event on non-2xx', async () => {
    const connector = new HttpAuraConnector(`${baseUrl}/missing`);
    const events: AuraEvent[] = [];
    for await (const ev of connector.run({ sessionId: 's', messages: [] })) events.push(ev);
    expect(events[0]?.kind).toBe('error');
  });
});
