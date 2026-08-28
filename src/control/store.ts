// Conversation tree per incident. Every aura answer posted to Slack becomes a
// node holding the full transcript up to it; a Slack thread reply's thread_ts
// finds the node to fork from. One aura session id per incident — reuse is
// load-bearing for aura's orchestration run store (prior-run artifacts).
// In-memory with optional JSON snapshots; bridge restarts kill in-flight runs
// anyway (SSE fail-closed), so durable state is deliberately not a goal.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ChatMessage } from '../aura/connector.js';

export interface ConversationNode {
  id: string;
  parentId?: string;
  /** Full transcript snapshot including this node's assistant answer. */
  messages: ChatMessage[];
  /** Slack ts of the posted answer — thread replies to it fork from this node. */
  slackTs?: string;
  createdAt: string;
}

export interface Incident {
  id: string;
  sessionId: string;
  channelId: string;
  title?: string;
  nodes: Record<string, ConversationNode>;
  /** Main-line tip: in-channel follow-ups append here. Thread forks never move it. */
  tipNodeId?: string;
  createdAt: string;
}

export class IncidentStore {
  private incidents = new Map<string, Incident>();
  private nodeCounter = 0;
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(private stateFile?: string) {}

  upsertIncident(opts: { id: string; channelId: string; title?: string }): Incident {
    const existing = this.incidents.get(opts.id);
    if (existing) return existing;
    const incident: Incident = {
      id: opts.id,
      sessionId: `pd-${opts.id}`,
      channelId: opts.channelId,
      title: opts.title,
      nodes: {},
      createdAt: new Date().toISOString(),
    };
    this.incidents.set(opts.id, incident);
    this.scheduleSave();
    return incident;
  }

  getIncident(id: string): Incident | undefined {
    return this.incidents.get(id);
  }

  findByChannel(channelId: string): Incident | undefined {
    for (const incident of this.incidents.values()) {
      if (incident.channelId === channelId) return incident;
    }
    return undefined;
  }

  findNodeBySlackTs(incident: Incident, slackTs: string): ConversationNode | undefined {
    return Object.values(incident.nodes).find((n) => n.slackTs === slackTs);
  }

  addNode(
    incident: Incident,
    opts: { parentId?: string; messages: ChatMessage[]; slackTs?: string; mainLine: boolean },
  ): ConversationNode {
    const node: ConversationNode = {
      id: `node-${++this.nodeCounter}`,
      parentId: opts.parentId,
      messages: opts.messages,
      slackTs: opts.slackTs,
      createdAt: new Date().toISOString(),
    };
    incident.nodes[node.id] = node;
    if (opts.mainLine) incident.tipNodeId = node.id;
    this.scheduleSave();
    return node;
  }

  listIncidents(): Incident[] {
    return [...this.incidents.values()];
  }

  load(): void {
    if (!this.stateFile) return;
    let raw: string;
    try {
      raw = readFileSync(this.stateFile, 'utf8');
    } catch {
      return; // first boot
    }
    const parsed = JSON.parse(raw) as { nodeCounter: number; incidents: Incident[] };
    this.nodeCounter = parsed.nodeCounter;
    this.incidents = new Map(parsed.incidents.map((i) => [i.id, i]));
  }

  saveNow(): void {
    if (!this.stateFile) return;
    const data = JSON.stringify({
      nodeCounter: this.nodeCounter,
      incidents: [...this.incidents.values()],
    });
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, this.stateFile);
  }

  private scheduleSave(): void {
    if (!this.stateFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.saveNow();
    }, 500);
    this.saveTimer.unref?.();
  }
}
