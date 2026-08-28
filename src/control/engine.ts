// Investigation engine: the routing/control layer between triggers, aura, and
// Slack. Owns the conversation tree, per-incident FIFO, the approval registry,
// and which messages exist; how the live status message reads is
// outbound/status.ts's job. Triggers stay thin.
import type { FastifyBaseLogger } from 'fastify';
import type { AuraConnector, ChatMessage } from '../aura/connector.js';
import { markdownToMrkdwn } from '../outbound/mrkdwn.js';
import { approvalBlocks, approvalResolvedBlocks, type SlackPort } from '../outbound/slack.js';
import { RunStatusMessage } from '../outbound/status.js';
import { authorizeButton } from './approver.js';
import { KeyedQueue } from './queue.js';
import type { Incident, IncidentStore } from './store.js';

export interface EngineDeps {
  store: IncidentStore;
  slack: SlackPort;
  /** Resolved per run so the admin API can flip real/sim live. */
  connector: () => AuraConnector;
  logger: FastifyBaseLogger;
  statusUpdateIntervalMs: number;
  /** `{number}` is replaced with the PD incident number. Must match the PD
   * incident workflow's "Create a Slack Channel" action. */
  channelNamePattern: string;
  /** The PD webhook races the workflow's channel creation — retry the lookup. */
  channelResolve: { attempts: number; delayMs: number };
}

interface RunRequest {
  incident: Incident;
  parentNodeId?: string;
  prompt: string;
  /** Reply into this thread; undefined = channel top level (main line). */
  threadTs?: string;
}

interface PendingApproval {
  connectorName: string;
  toolName: string;
  channel: string;
  ts: string;
  incidentId: string;
}

interface ActiveRun {
  controller: AbortController;
  /** Set by handleStopAction before aborting — how the catch path tells a
   * user-stop from a real failure. */
  stoppedBy?: string;
}

export class InvestigationEngine {
  private queue = new KeyedQueue();
  private pendingApprovals = new Map<string, PendingApproval>();
  /** At most one per incident — the KeyedQueue serializes runs. */
  private activeRuns = new Map<string, ActiveRun>();

  constructor(private deps: EngineDeps) {}

  /** PagerDuty webhook (or admin injection): start the root investigation.
   * Without an explicit channelId, the incident channel is resolved from the
   * naming pattern + incident number. */
  async handlePdIncident(opts: {
    incidentId: string;
    incidentNumber?: number;
    channelId?: string;
    title?: string;
  }): Promise<void> {
    let channelId = opts.channelId;
    if (!channelId) {
      if (opts.incidentNumber === undefined) {
        throw new Error('need channelId or incidentNumber to locate the incident channel');
      }
      channelId = await this.resolveIncidentChannel(opts.incidentNumber);
    } else {
      // PD's workflow created this channel moments ago — the bot isn't in it.
      await this.joinQuietly(channelId);
    }
    const incident = this.deps.store.upsertIncident({
      id: opts.incidentId,
      channelId,
      title: opts.title,
    });
    const prompt = `Investigate PagerDuty incident ${incident.id}${incident.title ? `: "${incident.title}"` : ''}. Identify the root cause and impacted services; report specific resource names and evidence.`;
    return this.enqueue({ incident, prompt });
  }

  /** Slack @mention. In-channel = resume main line; thread reply under an aura answer = fork from it. */
  async handleMention(opts: { channelId: string; text: string; threadTs?: string }): Promise<void> {
    const incident = this.deps.store.findByChannel(opts.channelId);
    if (!incident) {
      // Tagging aura outside an incident channel is disabled for now.
      this.deps.logger.info({ channelId: opts.channelId }, 'mention outside incident channel ignored');
      return;
    }
    let parentNodeId = incident.tipNodeId;
    if (opts.threadTs) {
      const node = this.deps.store.findNodeBySlackTs(incident, opts.threadTs);
      if (node) parentNodeId = node.id;
    }
    return this.enqueue({ incident, parentNodeId, prompt: opts.text, threadTs: opts.threadTs });
  }

  /** Slack button click (or admin/TUI). Returns text describing what happened, for the message update. */
  async handleApprovalAction(opts: {
    decisionId: string;
    userId: string;
    userName?: string;
    approved: boolean;
  }): Promise<string> {
    const pending = this.pendingApprovals.get(opts.decisionId);
    const incident = pending ? this.deps.store.getIncident(pending.incidentId) : undefined;
    if (!authorizeButton(opts.approved ? 'approve' : 'deny', opts.userId, incident)) {
      return 'You are not authorized to approve AURA actions for this incident.';
    }
    // The reason lands in aura's transcript/logs — a handle reads better than
    // a raw Slack id.
    const approver = opts.userName ? `@${opts.userName} (${opts.userId})` : opts.userId;
    const resolved = await this.deps.connector().resolveApproval(
      opts.decisionId,
      opts.approved,
      opts.approved ? undefined : `denied by ${approver}`,
    );
    if (!resolved) return 'This approval already expired or was resolved.';
    if (pending) {
      this.pendingApprovals.delete(opts.decisionId);
      await this.deps.slack.updateMessage({
        channel: pending.channel,
        ts: pending.ts,
        text: `\`${pending.toolName}\` ${opts.approved ? 'approved' : 'denied'}`,
        blocks: approvalResolvedBlocks({
          toolName: pending.toolName,
          outcome: opts.approved ? 'approved' : 'denied',
          actor: opts.userId,
        }),
      });
    }
    return opts.approved ? 'Approved — AURA is continuing.' : 'Denied — AURA will stop that action.';
  }

  /** Stop button click (or admin/TUI). Aborts the incident's active run; the
   * run's own catch path renders the stopped board and cleans up approvals.
   * Returns text describing what happened. */
  async handleStopAction(opts: { incidentId: string; userId: string; userName?: string }): Promise<string> {
    const incident = this.deps.store.getIncident(opts.incidentId);
    if (!authorizeButton('stop', opts.userId, incident)) {
      return 'You are not authorized to stop AURA runs for this incident.';
    }
    const run = this.activeRuns.get(opts.incidentId);
    if (!run) return 'No AURA run is in progress for this incident.';
    if (run.stoppedBy) return 'Already stopping.';
    run.stoppedBy = opts.userId;
    run.controller.abort();
    return 'Stopping — AURA is cancelling this run.';
  }

  status(): { incidents: number; pendingApprovals: string[]; busy: string[] } {
    const incidents = this.deps.store.listIncidents();
    return {
      incidents: incidents.length,
      pendingApprovals: [...this.pendingApprovals.keys()],
      busy: incidents.filter((i) => this.queue.isBusy(i.id)).map((i) => i.id),
    };
  }

  private async joinQuietly(channelId: string): Promise<void> {
    try {
      await this.deps.slack.joinChannel(channelId);
    } catch (err) {
      // already_in_channel and friends — posting will surface real failures.
      this.deps.logger.info({ err, channelId }, 'joinChannel failed, continuing');
    }
  }

  private async resolveIncidentChannel(incidentNumber: number): Promise<string> {
    const name = this.deps.channelNamePattern.replace('{number}', String(incidentNumber));
    const { attempts, delayMs } = this.deps.channelResolve;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const channelId = await this.deps.slack.findChannelId(name);
      if (channelId) {
        await this.joinQuietly(channelId);
        return channelId;
      }
      this.deps.logger.info({ name, attempt }, 'incident channel not found yet, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`incident channel "${name}" not found after ${attempts} attempts`);
  }

  private enqueue(req: RunRequest): Promise<void> {
    if (this.queue.isBusy(req.incident.id)) {
      void this.deps.slack.postMessage({
        channel: req.incident.channelId,
        threadTs: req.threadTs,
        text: ':hourglass: AURA is queued behind the current investigation.',
      });
    }
    return this.queue.run(req.incident.id, () => this.execute(req));
  }

  private async execute(req: RunRequest): Promise<void> {
    const { slack, store, logger } = this.deps;
    const messages = this.buildMessages(req);
    const run: ActiveRun = { controller: new AbortController() };
    const status = new RunStatusMessage({
      slack,
      channel: req.incident.channelId,
      threadTs: req.threadTs,
      incidentId: req.incident.id,
      updateIntervalMs: this.deps.statusUpdateIntervalMs,
    });
    await status.post();
    // Registered only once the status message (and its Stop button) exists.
    this.activeRuns.set(req.incident.id, run);

    let finalText: string | undefined;
    const connector = this.deps.connector();

    try {
      for await (const ev of connector.run({
        sessionId: req.incident.sessionId,
        messages,
        signal: run.controller.signal,
      })) {
        switch (ev.kind) {
          case 'progress':
          case 'tool_activity':
          case 'orchestration':
          case 'usage':
            await status.apply(ev);
            break;
          case 'approval_pending': {
            const posted = await slack.postMessage({
              channel: req.incident.channelId,
              threadTs: req.threadTs,
              // HITL messages born in a thread must also land in the channel.
              broadcast: Boolean(req.threadTs),
              text: `AURA wants to run \`${ev.toolName}\` — approve or deny`,
              blocks: approvalBlocks({ decisionId: ev.decisionId, toolName: ev.toolName, args: ev.args }),
            });
            this.pendingApprovals.set(ev.decisionId, {
              connectorName: connector.name,
              toolName: ev.toolName,
              channel: posted.channel,
              ts: posted.ts,
              incidentId: req.incident.id,
            });
            break;
          }
          case 'approval_completed': {
            // Normally resolved by handleApprovalAction; this catches timeouts
            // and out-of-band resolutions.
            const pending = this.pendingApprovals.get(ev.decisionId);
            if (pending) {
              this.pendingApprovals.delete(ev.decisionId);
              await slack.updateMessage({
                channel: pending.channel,
                ts: pending.ts,
                text: `\`${pending.toolName}\` ${ev.outcome}`,
                blocks: approvalResolvedBlocks({ toolName: pending.toolName, outcome: ev.outcome }),
              });
            }
            break;
          }
          case 'final':
            finalText = ev.text;
            break;
          case 'error':
            throw new Error(ev.message);
        }
      }

      if (finalText === undefined) throw new Error('run ended without a final response');

      const answer = await slack.postMessage({
        channel: req.incident.channelId,
        threadTs: req.threadTs,
        text: markdownToMrkdwn(finalText),
      });
      await status.complete();
      store.addNode(req.incident, {
        parentId: req.parentNodeId,
        messages: [...messages, { role: 'assistant', content: finalText }],
        slackTs: answer.ts,
        // Thread forks never move the main-line tip.
        mainLine: !req.threadTs,
      });
    } catch (err) {
      if (run.stoppedBy) {
        logger.info({ incident: req.incident.id, stoppedBy: run.stoppedBy }, 'investigation stopped');
        await status.stopped(run.stoppedBy);
      } else {
        logger.error({ err, incident: req.incident.id }, 'investigation failed');
        await status.failed((err as Error).message);
      }
      // Aura denies parked approvals on disconnect, but the stream is gone —
      // no approval_completed will arrive, so resolve their messages here.
      await this.cancelPendingApprovals(req.incident.id);
    } finally {
      this.activeRuns.delete(req.incident.id);
    }
  }

  private async cancelPendingApprovals(incidentId: string): Promise<void> {
    for (const [decisionId, pending] of this.pendingApprovals) {
      if (pending.incidentId !== incidentId) continue;
      this.pendingApprovals.delete(decisionId);
      await this.deps.slack.updateMessage({
        channel: pending.channel,
        ts: pending.ts,
        text: `\`${pending.toolName}\` cancelled — run ended`,
        blocks: approvalResolvedBlocks({ toolName: pending.toolName, outcome: 'cancelled' }),
      });
    }
  }

  private buildMessages(req: RunRequest): ChatMessage[] {
    const parent = req.parentNodeId ? req.incident.nodes[req.parentNodeId] : undefined;
    // Parent snapshots are resent verbatim — aura scratchpad pointers live in
    // tool messages and break if history is pruned or rewritten.
    const history = parent ? parent.messages : [];
    return [...history, { role: 'user', content: req.prompt }];
  }
}
