// RunStatusMessage in isolation: event → text rendering and the message
// lifecycle. Board chronology across replans is covered end-to-end in
// flow.test.ts.
import { describe, expect, it } from 'vitest';
import { formatArgs, RunStatusMessage } from '../src/outbound/status.js';
import { RecordingSlack } from './helpers.js';

function setup() {
  const slack = new RecordingSlack();
  const status = new RunStatusMessage({
    slack,
    channel: 'C1',
    incidentId: 'P1',
    updateIntervalMs: 0,
  });
  return { slack, status };
}

describe('RunStatusMessage', () => {
  it('renders plain progress with token totals until orchestration events arrive', async () => {
    const { slack, status } = setup();
    await status.post();
    expect(slack.posts[0]!.text).toContain('AURA is working');
    expect(JSON.stringify(slack.posts[0]!.blocks)).toContain('aura_stop');

    await status.apply({ kind: 'progress', message: 'dispatching cluster_inspector' });
    await status.apply({ kind: 'usage', totalTokens: 4200 });
    expect(slack.updates.at(-1)!.text).toContain('_dispatching cluster_inspector_');
    expect(slack.updates.at(-1)!.text).toContain('~4.2k tokens');

    await status.apply({ kind: 'tool_activity', phase: 'started', toolName: 'SearchCode' });
    expect(slack.updates.at(-1)!.text).toContain('running `SearchCode`');

    // The first orchestration event switches the message to the task board.
    await status.apply({
      kind: 'orchestration',
      update: { type: 'tool_call_started', taskId: 0, workerId: 'github_analyst', toolName: 'SearchCode', args: { page: 1 } },
    });
    expect(slack.updates.at(-1)!.text).toContain('● Task 0 — github_analyst — SearchCode(page: 1)');
  });

  it('final edits carry the board log and drop the Stop button', async () => {
    const { slack, status } = setup();
    await status.post();
    await status.apply({ kind: 'orchestration', update: { type: 'plan_created', goal: 'find leak' } });
    await status.apply({
      kind: 'orchestration',
      update: { type: 'task_completed', taskId: 0, workerId: 'github_analyst', success: false },
    });

    await status.complete();
    const done = slack.updates.at(-1)!;
    expect(done.text).toContain(':mag: *Done*');
    expect(done.text).toContain('● Coordinator — Plan — find leak');
    expect(done.text).toContain('● Task 0 — github_analyst — Failed');
    expect(JSON.stringify(done.blocks)).not.toContain('aura_stop');

    await status.stopped('U77');
    expect(slack.updates.at(-1)!.text).toContain('Stopped* by <@U77>');
    await status.failed('boom');
    expect(slack.updates.at(-1)!.text).toBe(':x: AURA investigation failed: boom');
  });
});

describe('formatArgs', () => {
  it('formats tool args compactly', () => {
    expect(formatArgs({ order: 'desc', page: 1, deep: { a: 1 } })).toBe('order: "desc", page: 1, deep: {"a":1}');
    expect(formatArgs({ q: 'this string is much longer than seventeen chars' })).toBe('q: "this string is mu…"');
    expect(formatArgs({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('a: 1, b: 2, c: 3, d: 4, …');
    expect(formatArgs(undefined)).toBe('');
  });
});
