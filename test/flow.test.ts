// End-to-end control flow: engine + sim connector + recording slack. Covers
// the full demo choreography without Slack, PagerDuty, aura, or a network.
import { describe, expect, it } from 'vitest';
import { SimAuraConnector } from '../src/aura/sim.js';
import { InvestigationEngine } from '../src/control/engine.js';
import { IncidentStore } from '../src/control/store.js';
import { noopLogger, RecordingSlack, until } from './helpers.js';

function setup() {
  const store = new IncidentStore();
  const slack = new RecordingSlack();
  const sim = new SimAuraConnector(1);
  const engine = new InvestigationEngine({
    store,
    slack,
    connector: () => sim,
    logger: noopLogger,
    statusUpdateIntervalMs: 0,
    channelNamePattern: 'incident_{number}',
    channelResolve: { attempts: 5, delayMs: 5 },
  });
  return { store, slack, sim, engine };
}

describe('InvestigationEngine', () => {
  it('runs the PD-triggered root investigation', async () => {
    const { store, slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P1', channelId: 'C1', title: 'cart is down' });

    // PD created the channel; the bot must join before posting.
    expect(slack.joined).toContain('C1');

    const investigating = slack.posts[0];
    expect(investigating?.text).toContain('AURA is working');
    expect(slack.updates.length).toBeGreaterThan(0); // live status edits
    const final = slack.posts.at(-1);
    expect(final?.text).toContain('Root cause');
    // Completion line carries the totals: elapsed and token spend.
    const done = slack.updates.at(-1);
    expect(done?.text).toContain('Done');
    expect(done?.text).toContain('tokens');

    const incident = store.getIncident('P1');
    expect(incident?.tipNodeId).toBeDefined();
    const tip = incident!.nodes[incident!.tipNodeId!];
    expect(tip?.slackTs).toBe(final?.ts);
    expect(tip?.messages.at(0)?.content).toContain('P1');
    expect(tip?.messages.at(-1)?.role).toBe('assistant');
  });

  it('in-channel mention resumes the main line with full history', async () => {
    const { store, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P2', channelId: 'C2' });
    const rootTip = store.getIncident('P2')!.tipNodeId!;

    await engine.handleMention({ channelId: 'C2', text: 'what about the database?' });

    const incident = store.getIncident('P2')!;
    expect(incident.tipNodeId).not.toBe(rootTip);
    const tip = incident.nodes[incident.tipNodeId!]!;
    expect(tip.parentId).toBe(rootTip);
    // root(user+assistant) + followup(user+assistant)
    expect(tip.messages).toHaveLength(4);
  });

  it('thread reply forks from that answer and leaves the tip alone', async () => {
    const { store, slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P3', channelId: 'C3' });
    const rootAnswerTs = slack.posts.at(-1)!.ts;
    await engine.handleMention({ channelId: 'C3', text: 'followup one' });
    const tipAfterFollowup = store.getIncident('P3')!.tipNodeId!;

    await engine.handleMention({ channelId: 'C3', text: 'thread question', threadTs: rootAnswerTs });

    const incident = store.getIncident('P3')!;
    expect(incident.tipNodeId).toBe(tipAfterFollowup); // fork didn't move the tip
    // Replies landed in the thread; the answer there is the fork node.
    const threadPosts = slack.posts.filter((p) => p.threadTs === rootAnswerTs);
    expect(threadPosts.length).toBeGreaterThanOrEqual(2); // investigating + answer
    const fork = store.findNodeBySlackTs(incident, threadPosts.at(-1)!.ts);
    expect(fork).toBeDefined();
    expect(incident.nodes[fork!.parentId!]?.slackTs).toBe(rootAnswerTs);
    // Forked from root (2 messages), not from the followup tip (4).
    expect(fork!.messages).toHaveLength(4);
    expect(fork!.messages[2]?.content).toBe('thread question');
  });

  it('ignores mentions outside incident channels', async () => {
    const { slack, engine } = setup();
    await engine.handleMention({ channelId: 'C-random', text: 'hello?' });
    expect(slack.posts).toHaveLength(0);
  });

  it('queues overlapping requests on one incident', async () => {
    const { slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P4', channelId: 'C4' });
    const first = engine.handleMention({ channelId: 'C4', text: 'one' });
    const second = engine.handleMention({ channelId: 'C4', text: 'two' });
    await Promise.all([first, second]);
    expect(slack.posts.some((p) => p.text.includes('queued'))).toBe(true);
    // Both runs completed with final answers.
    const finals = slack.posts.filter((p) => p.text.includes('Root cause'));
    expect(finals.length).toBeGreaterThanOrEqual(3);
  });

  it('posts approval buttons, resolves via action, broadcasts from threads', async () => {
    const { slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P5', channelId: 'C5' });
    const rootAnswerTs = slack.posts.at(-1)!.ts;

    const run = engine.handleMention({
      channelId: 'C5',
      text: 'can you check the node logs?',
      threadTs: rootAnswerTs,
    });
    await until(() => engine.status().pendingApprovals.length > 0);

    const buttonPost = slack.posts.find((p) => p.blocks && p.text.includes('nodes_log'));
    expect(buttonPost).toBeDefined();
    expect(buttonPost!.threadTs).toBe(rootAnswerTs);
    expect(buttonPost!.broadcast).toBe(true); // "also send to #channel"

    const decisionId = engine.status().pendingApprovals[0]!;
    const outcome = await engine.handleApprovalAction({ decisionId, userId: 'U123', approved: true });
    expect(outcome).toContain('Approved');
    await run;

    const buttonUpdate = slack.updates.find((u) => u.ts === buttonPost!.ts);
    expect(buttonUpdate?.text).toContain('approved');
    expect(engine.status().pendingApprovals).toHaveLength(0);
    expect(slack.posts.at(-1)!.text).toContain('kubelet');
  });

  it('resolves the incident channel from the naming pattern, with retry and join', async () => {
    const { store, slack, engine } = setup();
    // Channel appears only after the first lookup — the PD webhook racing the
    // workflow's channel creation.
    setTimeout(() => slack.channels.set('incident_42', 'C-INC42'), 12);
    await engine.handlePdIncident({ incidentId: 'PD-abc', incidentNumber: 42 });

    expect(slack.findChannelIdCalls).toBeGreaterThan(1);
    expect(slack.joined).toContain('C-INC42');
    expect(store.getIncident('PD-abc')?.channelId).toBe('C-INC42');
    expect(slack.posts.at(-1)?.channel).toBe('C-INC42');
  });

  it('fails cleanly when the incident channel never appears', async () => {
    const { slack, engine } = setup();
    await expect(engine.handlePdIncident({ incidentId: 'PD-x', incidentNumber: 7 })).rejects.toThrow(
      'incident_7',
    );
    expect(slack.posts).toHaveLength(0);
  });

  it('renders the task board from orchestration events, keeping done rows as a log', async () => {
    const store = new IncidentStore();
    const slack = new RecordingSlack();
    const boardConnector = {
      name: 'stub',
      async *run() {
        yield { kind: 'orchestration', update: { type: 'plan_created', goal: 'find leak' } } as const;
        yield { kind: 'orchestration', update: { type: 'worker_reasoning', taskId: 0, workerId: 'github_analyst' } } as const;
        yield { kind: 'orchestration', update: { type: 'tool_call_started', taskId: 1, workerId: 'metrics_analyst', toolName: 'QueryPrometheus', args: { expr: 'up' } } } as const;
        yield { kind: 'orchestration', update: { type: 'task_completed', taskId: 0, workerId: 'github_analyst', success: true } } as const;
        yield { kind: 'final', text: 'answer' } as const;
      },
      async resolveApproval() {
        return false;
      },
    };
    const engine = new InvestigationEngine({
      store,
      slack,
      connector: () => boardConnector,
      logger: noopLogger,
      statusUpdateIntervalMs: 0,
      channelNamePattern: 'incident_{number}',
      channelResolve: { attempts: 2, delayMs: 5 },
    });
    await engine.handlePdIncident({ incidentId: 'PB', channelId: 'CB' });

    const boardEdits = slack.updates.filter((u) => u.text.includes('AURA is working'));
    expect(boardEdits.length).toBeGreaterThanOrEqual(3);
    const full = boardEdits.find((u) => u.text.includes('Task 1'))!;
    // Coordinator row first, then tasks in order; one line each.
    const lines = full.text.split('\n');
    expect(lines[0]).toContain('AURA is working');
    expect(lines.filter((l) => l.startsWith('● '))).toHaveLength(3);
    expect(lines[1]).toContain('Coordinator');
    // Done rows persist, and the task log survives the completion edit.
    const doneEdit = boardEdits.at(-1)!;
    expect(doneEdit.text).toContain('github_analyst — Done');
    const finalEdit = slack.updates.at(-1)!;
    expect(finalEdit.text).toContain(':mag: *Done*');
    expect(finalEdit.text).toContain('github_analyst — Done');
    expect(finalEdit.text).toContain('Task 1');
  });

  it('keeps the board chronological across replans: done rows freeze, returning actors get new rows', async () => {
    const store = new IncidentStore();
    const slack = new RecordingSlack();
    const replanConnector = {
      name: 'stub',
      async *run() {
        yield { kind: 'orchestration', update: { type: 'plan_created', goal: 'find leak' } } as const;
        yield { kind: 'orchestration', update: { type: 'worker_reasoning', taskId: 0, workerId: 'incident_responder' } } as const;
        yield { kind: 'orchestration', update: { type: 'worker_reasoning', taskId: 1, workerId: 'metrics_analyst' } } as const;
        yield { kind: 'orchestration', update: { type: 'task_completed', taskId: 0, workerId: 'incident_responder', success: true } } as const;
        // Replan: aura emits plan_created for the new plan, then replan_started —
        // consecutive coordinator events share one row (latest text wins).
        yield { kind: 'orchestration', update: { type: 'plan_created', goal: 'narrower goal' } } as const;
        yield { kind: 'orchestration', update: { type: 'replan_started', trigger: 'gaps found' } } as const;
        // Straggler from wave 1 finishes after the replan row appeared: its live
        // row (above the replan) updates in place.
        yield { kind: 'orchestration', update: { type: 'task_completed', taskId: 1, workerId: 'metrics_analyst', success: true } } as const;
        // New wave reuses task id 0 — must get a fresh row, not revive wave 1's.
        yield { kind: 'orchestration', update: { type: 'worker_reasoning', taskId: 0, workerId: 'cluster_inspector' } } as const;
        yield { kind: 'orchestration', update: { type: 'task_completed', taskId: 0, workerId: 'cluster_inspector', success: true } } as const;
        yield { kind: 'orchestration', update: { type: 'direct_answer' } } as const;
        yield { kind: 'final', text: 'answer' } as const;
      },
      async resolveApproval() {
        return false;
      },
    };
    const engine = new InvestigationEngine({
      store,
      slack,
      connector: () => replanConnector,
      logger: noopLogger,
      statusUpdateIntervalMs: 0,
      channelNamePattern: 'incident_{number}',
      channelResolve: { attempts: 2, delayMs: 5 },
    });
    await engine.handlePdIncident({ incidentId: 'PR', channelId: 'CR' });

    const finalEdit = slack.updates.at(-1)!;
    const rows = finalEdit.text.split('\n').filter((l) => l.startsWith('● '));
    expect(rows).toEqual([
      '● Coordinator — Plan — find leak',
      '● Task 0 — incident_responder — Done',
      '● Task 1 — metrics_analyst — Done',
      '● Coordinator — Replanning — gaps found',
      '● Task 0 — cluster_inspector — Done',
      '● Coordinator — Answering directly',
    ]);
  });

  it('reports unknown decisions as expired', async () => {
    const { engine } = setup();
    const outcome = await engine.handleApprovalAction({ decisionId: 'ghost', userId: 'U1', approved: true });
    expect(outcome).toContain('expired');
  });

  it('stop button aborts the run: stopped edit keeps the board, no answer, no store node', async () => {
    const { store, slack, engine } = setup();
    const run = engine.handlePdIncident({ incidentId: 'P6', channelId: 'C6', title: 'slow checkout' });
    await until(() => engine.status().busy.includes('P6'));

    const outcome = await engine.handleStopAction({ incidentId: 'P6', userId: 'U77' });
    expect(outcome).toContain('Stopping');
    await run;

    // The status message carried a Stop button while live…
    const statusPost = slack.posts.find((p) => p.text.includes('AURA is working'))!;
    expect(JSON.stringify(statusPost.blocks)).toContain('aura_stop');
    // …and the stopped edit drops it and credits the stopper.
    const last = slack.updates.at(-1)!;
    expect(last.text).toContain('Stopped* by <@U77>');
    expect(JSON.stringify(last.blocks)).not.toContain('aura_stop');
    // No answer posted, no conversation node recorded.
    expect(slack.posts.some((p) => p.text.includes('Root cause'))).toBe(false);
    expect(store.getIncident('P6')?.tipNodeId).toBeUndefined();
    expect(engine.status().busy).toHaveLength(0);
  });

  it('stopping a run with a parked approval cancels the approval message', async () => {
    const { slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P7', channelId: 'C7' });
    const run = engine.handleMention({ channelId: 'C7', text: 'check the node logs' });
    await until(() => engine.status().pendingApprovals.length > 0);
    const buttonPost = slack.posts.find((p) => p.blocks && p.text.includes('nodes_log'))!;

    await engine.handleStopAction({ incidentId: 'P7', userId: 'U77' });
    await run;

    expect(engine.status().pendingApprovals).toHaveLength(0);
    const buttonUpdate = slack.updates.find((u) => u.ts === buttonPost.ts)!;
    expect(buttonUpdate.text).toContain('cancelled');
    expect(slack.updates.some((u) => u.text.includes('Stopped* by'))).toBe(true);
  });

  it('completion edit removes the Stop button', async () => {
    const { slack, engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P8', channelId: 'C8' });
    const last = slack.updates.at(-1)!;
    expect(last.text).toContain(':mag: *Done*');
    expect(last.blocks).toBeDefined();
    expect(JSON.stringify(last.blocks)).not.toContain('aura_stop');
  });

  it('stop with no active run reports so', async () => {
    const { engine } = setup();
    await engine.handlePdIncident({ incidentId: 'P9', channelId: 'C9' });
    const outcome = await engine.handleStopAction({ incidentId: 'P9', userId: 'U1' });
    expect(outcome).toContain('No AURA run is in progress');
  });
});
