// The live run-status message: one Slack message per run, posted at start and
// edited in place until the run ends. The only place that turns AuraEvents
// into English — connectors emit facts, the engine routes, this file renders.
// Owns the chronological task board, free-text progress, token totals, and
// dropping the Stop button on the final edit.
import type { AuraEvent, OrchestrationUpdate } from '../aura/connector.js';
import { runStatusBlocks, type SlackPort } from './slack.js';

export interface RunStatusDeps {
  slack: SlackPort;
  channel: string;
  /** Post into this thread; undefined = channel top level. */
  threadTs?: string;
  /** Carried in the Stop button so the click routes back to this run. */
  incidentId: string;
  updateIntervalMs: number;
}

/** One row of the task board. Live rows update in place; done rows freeze and
 * stay as the persistent task log. */
interface Row {
  /** 'coordinator' or 'task-<n>' — the actor the row belongs to. */
  key: string;
  text: string;
  done: boolean;
}

export class RunStatusMessage {
  // Orchestration task board: a chronological log, not one-row-per-actor.
  // A returning actor gets a fresh row below — task ids restart at 0 on every
  // replan wave, so a done `task-0` row is a prior wave's record, and each
  // coordinator reappearance (replan, extra dispatch, synthesis) opens a new
  // segment of the log.
  private board: Row[] = [];
  private latest?: string;
  private tokens = 0;
  private startedAt = Date.now();
  private lastEdit = 0;
  private msg?: { channel: string; ts: string };

  constructor(private deps: RunStatusDeps) {}

  /** Post the initial "AURA is working…" message, with a Stop button. */
  async post(): Promise<void> {
    const text = this.renderLive();
    this.msg = await this.deps.slack.postMessage({
      channel: this.deps.channel,
      threadTs: this.deps.threadTs,
      text,
      blocks: runStatusBlocks({ text, stop: { incidentId: this.deps.incidentId } }),
    });
    this.startedAt = Date.now();
  }

  /** Fold a display event into the message (edits are throttled). Non-display
   * kinds (approvals, final, error) are the engine's business and are ignored. */
  async apply(ev: AuraEvent): Promise<void> {
    switch (ev.kind) {
      case 'progress':
        this.latest = ev.message;
        break;
      case 'tool_activity':
        this.latest = ev.phase === 'started' ? `running \`${ev.toolName}\`` : `\`${ev.toolName}\` finished`;
        break;
      case 'orchestration':
        this.applyRow(rowFor(ev.update));
        break;
      case 'usage':
        this.tokens += ev.totalTokens;
        break;
      default:
        return;
    }
    await this.edit();
  }

  /** Final edit for a completed run: totals line + the persistent task log. */
  async complete(): Promise<void> {
    await this.update([doneText(this.startedAt, this.tokens), ...this.rows()].join('\n'));
  }

  /** Final edit for a user-stopped run: credits the stopper, keeps the log. */
  async stopped(userId: string): Promise<void> {
    await this.update([stoppedText(userId, this.startedAt, this.tokens), ...this.rows()].join('\n'));
  }

  /** Final edit for a failed run. */
  async failed(message: string): Promise<void> {
    await this.update(`:x: AURA investigation failed: ${message}`);
  }

  private applyRow(row: Row): void {
    if (row.key === 'coordinator') {
      // Coordinator events arrive in bursts (plan_created → replan_started
      // back-to-back): consecutive ones share a row, keeping the latest text.
      const last = this.board.at(-1);
      if (last?.key === 'coordinator') last.text = row.text;
      else this.board.push(row);
      return;
    }
    const live = this.board.findLast((r) => r.key === row.key);
    if (live && !live.done) {
      live.text = row.text;
      live.done = row.done;
    } else {
      this.board.push(row);
    }
  }

  private rows(): string[] {
    return this.board.map((r) => `● ${r.text}`);
  }

  private renderLive(): string {
    // Boards replace plain progress once orchestration events appear.
    if (this.board.length === 0) return investigatingText(this.latest, this.tokens);
    return [':mag: *AURA is working…*', ...this.rows()].join('\n');
  }

  private async edit(): Promise<void> {
    const now = Date.now();
    if (now - this.lastEdit < this.deps.updateIntervalMs) return;
    this.lastEdit = now;
    await this.update(this.renderLive(), { stop: true });
  }

  private async update(text: string, opts?: { stop?: boolean }): Promise<void> {
    if (!this.msg) return;
    await this.deps.slack.updateMessage({
      channel: this.msg.channel,
      ts: this.msg.ts,
      text,
      // blocks without `stop` — the final edits are what remove the Stop button.
      blocks: runStatusBlocks({
        text,
        ...(opts?.stop ? { stop: { incidentId: this.deps.incidentId } } : {}),
      }),
    });
  }
}

function rowFor(u: OrchestrationUpdate): Row {
  const row = (text: string, done = false): Row => ({ key: actorKey(u), text, done });
  switch (u.type) {
    case 'plan_created':
      return row(`Coordinator — Plan — ${truncate(u.goal, 160)}`);
    case 'direct_answer':
      return row('Coordinator — Answering directly');
    case 'replan_started':
      return row(`Coordinator — Replanning — ${truncate(u.trigger, 120)}`);
    case 'synthesizing':
      return row('Coordinator — Synthesizing');
    case 'task_started':
      return row(`${actorLabel(u)} — ${truncate(u.description || 'starting', 120)}`);
    case 'worker_reasoning':
      return row(`${actorLabel(u)} — Reasoning`);
    case 'tool_call_started':
      return row(`${actorLabel(u)} — ${u.toolName || '?'}(${formatArgs(u.args)})`);
    case 'task_completed':
      return row(`${actorLabel(u)} — ${u.success ? 'Done' : 'Failed'}`, true);
  }
}

const actorKey = (u: OrchestrationUpdate): string =>
  'taskId' in u && u.taskId !== undefined ? `task-${u.taskId}` : 'coordinator';

const actorLabel = (u: { taskId?: number | string; workerId?: string }): string =>
  u.taskId === undefined ? 'Coordinator' : `Task ${u.taskId} — ${u.workerId ?? 'worker'}`;

/** `{a: "long value", b: 2}` → `a: "long val…", b: 2` — capped per value and overall. */
export function formatArgs(args: unknown): string {
  if (args === null || args === undefined || typeof args !== 'object' || Array.isArray(args)) return '';
  const entries = Object.entries(args as Record<string, unknown>);
  const parts = entries.slice(0, 4).map(([k, v]) => {
    if (typeof v === 'string') return `${k}: "${truncate(v, 17)}"`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
    return `${k}: ${truncate(JSON.stringify(v) ?? '?', 17)}`;
  });
  if (entries.length > 4) parts.push('…');
  return truncate(parts.join(', '), 110);
}

// Plain status (no board): single line, rewritten in place. Elapsed time and
// token spend keep it visibly alive between sparse events.
// No clock here by design; totals land on the completion line. Token counts
// appear mid-run only when aura reports them (today its orchestration mode
// reports usage once, at stream end — so real runs usually show them only on
// completion; the sim reports per-step).
function investigatingText(latest?: string, tokensUsed = 0): string {
  const parts = [`:mag: *AURA is working…*`];
  if (latest) parts.push(`_${truncate(latest, 120)}_`);
  if (tokensUsed > 0) parts.push(`~${formatTokens(tokensUsed)} tokens`);
  return parts.join(' — ');
}

function elapsedText(startedAt: number): string {
  const secs = Math.round((Date.now() - startedAt) / 1000);
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// No :white_check_mark: — it sits right next to the approval-resolved message,
// which owns that emoji.
function doneText(startedAt: number, tokensUsed = 0): string {
  const totals = [elapsedText(startedAt)];
  if (tokensUsed > 0) totals.push(`~${formatTokens(tokensUsed)} tokens`);
  return `:mag: *Done* (${totals.join(' · ')})`;
}

function stoppedText(userId: string, startedAt: number, tokensUsed = 0): string {
  const totals = [elapsedText(startedAt)];
  if (tokensUsed > 0) totals.push(`~${formatTokens(tokensUsed)} tokens`);
  return `:octagonal_sign: *Stopped* by <@${userId}> (${totals.join(' · ')})`;
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
