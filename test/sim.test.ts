import { describe, expect, it } from 'vitest';
import type { AuraEvent } from '../src/aura/connector.js';
import { SimAuraConnector } from '../src/aura/sim.js';

async function collect(gen: AsyncGenerator<AuraEvent>): Promise<AuraEvent[]> {
  const events: AuraEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('SimAuraConnector', () => {
  it('emits progress then a final response', async () => {
    const sim = new SimAuraConnector(1);
    const events = await collect(sim.run({ sessionId: 's1', messages: [{ role: 'user', content: 'investigate' }] }));
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'progress').length).toBeGreaterThanOrEqual(3);
    expect(kinds.at(-1)).toBe('final');
  });

  it('reports resumed sessions with history size', async () => {
    const sim = new SimAuraConnector(1);
    await collect(sim.run({ sessionId: 's2', messages: [{ role: 'user', content: 'first' }] }));
    const events = await collect(
      sim.run({
        sessionId: 's2',
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'answer' },
          { role: 'user', content: 'second' },
        ],
      }),
    );
    const resume = events.find((e) => e.kind === 'progress' && e.message.startsWith('Resuming'));
    expect(resume).toBeDefined();
    expect((resume as { message: string }).message).toContain('run 2');
    expect((resume as { message: string }).message).toContain('3 messages');
  });

  it('parks an approval on the trigger phrase and resumes on approve', async () => {
    const sim = new SimAuraConnector(1);
    const events: AuraEvent[] = [];
    const done = (async () => {
      for await (const ev of sim.run({ sessionId: 's3', messages: [{ role: 'user', content: 'check the node logs' }] })) {
        events.push(ev);
      }
    })();

    while (!events.some((e) => e.kind === 'approval_pending')) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const pending = events.find((e) => e.kind === 'approval_pending') as { decisionId: string };
    expect(await sim.resolveApproval(pending.decisionId, true)).toBe(true);
    await done;

    const completed = events.find((e) => e.kind === 'approval_completed') as { outcome: string };
    expect(completed.outcome).toBe('approved');
    expect(events.at(-1)?.kind).toBe('final');
  });

  it('denial still produces a final response', async () => {
    const sim = new SimAuraConnector(1);
    const events: AuraEvent[] = [];
    const done = (async () => {
      for await (const ev of sim.run({ sessionId: 's4', messages: [{ role: 'user', content: 'node log please' }] })) {
        events.push(ev);
      }
    })();
    while (!events.some((e) => e.kind === 'approval_pending')) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const pending = events.find((e) => e.kind === 'approval_pending') as { decisionId: string };
    await sim.resolveApproval(pending.decisionId, false);
    await done;
    const final = events.at(-1) as { kind: string; text: string };
    expect(final.kind).toBe('final');
    expect(final.text).toContain('denied');
  });

  it('rejects unknown decision ids', async () => {
    const sim = new SimAuraConnector(1);
    expect(await sim.resolveApproval('nope', true)).toBe(false);
  });
});
