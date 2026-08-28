// SlackPort: the only way the bridge talks to Slack. RealSlack wraps the Web
// API; ConsoleSlack logs instead (token-less dev/tests). Approval buttons and
// message formatting live here so control logic never sees Block Kit.
import type { FastifyBaseLogger } from 'fastify';

export interface PostedMessage {
  channel: string;
  ts: string;
}

export interface PostOptions {
  channel: string;
  text: string;
  /** Post into this thread instead of the channel top level. */
  threadTs?: string;
  /** Slack "also send to #channel" — required on HITL messages born in threads. */
  broadcast?: boolean;
  blocks?: unknown[];
}

export interface UpdateOptions {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[];
}

export interface SlackPort {
  postMessage(opts: PostOptions): Promise<PostedMessage>;
  updateMessage(opts: UpdateOptions): Promise<void>;
  /** Resolve a public channel's id by exact name; undefined if not found (yet). */
  findChannelId(name: string): Promise<string | undefined>;
  /** Join a public channel (bot must be a member to post). Idempotent. */
  joinChannel(channelId: string): Promise<void>;
}

/** Live status message: board text plus a Stop control while the run is
 * active. Every edit of the status message must resend blocks — chat.update
 * keeps the previous blocks when the field is omitted, so a text-only edit
 * would strand a stale Stop button on a finished run. */
export function runStatusBlocks(opts: { text: string; stop?: { incidentId: string } }): unknown[] {
  // Section blocks cap at 3000 chars; long boards split across sections.
  const blocks: unknown[] = chunkLines(opts.text, 2900).map((text) => ({
    type: 'section',
    text: { type: 'mrkdwn', text },
  }));
  if (opts.stop) {
    blocks.push({
      type: 'actions',
      block_id: 'aura_run',
      elements: [
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Stop' },
          action_id: 'aura_stop',
          value: opts.stop.incidentId,
        },
      ],
    });
  }
  return blocks;
}

export function approvalBlocks(opts: { decisionId: string; toolName: string; args: unknown }): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:rotating_light: AURA wants to run *\`${opts.toolName}\`*\n\`\`\`${truncate(JSON.stringify(opts.args, null, 2) ?? '{}', 500)}\`\`\``,
      },
    },
    {
      type: 'actions',
      block_id: 'aura_approval',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Approve' },
          action_id: 'aura_approve',
          value: opts.decisionId,
        },
        {
          type: 'button',
          style: 'danger',
          text: { type: 'plain_text', text: 'Deny' },
          action_id: 'aura_deny',
          value: opts.decisionId,
        },
      ],
    },
  ];
}

export function approvalResolvedBlocks(opts: { toolName: string; outcome: string; actor?: string }): unknown[] {
  const emoji = opts.outcome === 'approved' ? ':white_check_mark:' : ':no_entry:';
  const by = opts.actor ? ` by <@${opts.actor}>` : '';
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} \`${opts.toolName}\` ${opts.outcome}${by}` },
    },
  ];
}

export class ConsoleSlack implements SlackPort {
  private counter = 0;

  constructor(private logger: FastifyBaseLogger) {}

  async postMessage(opts: PostOptions): Promise<PostedMessage> {
    const ts = `console-${++this.counter}`;
    this.logger.info({ slack: { ...opts, ts } }, 'slack postMessage (console mode)');
    return { channel: opts.channel, ts };
  }

  async updateMessage(opts: UpdateOptions): Promise<void> {
    this.logger.info({ slack: opts }, 'slack updateMessage (console mode)');
  }

  async findChannelId(name: string): Promise<string | undefined> {
    // Deterministic fake so PD-triggered flows work without a workspace.
    return `C-${name}`;
  }

  async joinChannel(channelId: string): Promise<void> {
    this.logger.info({ channelId }, 'slack joinChannel (console mode)');
  }
}

// Structural view of @slack/web-api's WebClient. Method args are `never` so
// the real client (with its strict argument types) stays assignable.
export interface SlackWebApi {
  chat: {
    postMessage(args: never): Promise<{ ts?: string; channel?: string }>;
    update(args: never): Promise<unknown>;
  };
  conversations: {
    list(args: never): Promise<{
      channels?: Array<{ id?: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    }>;
    join(args: never): Promise<unknown>;
  };
}

/** Wraps @slack/web-api. Constructed lazily so console mode never needs the dep configured. */
export class RealSlack implements SlackPort {
  constructor(private client: SlackWebApi) {}

  async postMessage(opts: PostOptions): Promise<PostedMessage> {
    const res = await this.client.chat.postMessage({
      channel: opts.channel,
      text: opts.text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
      ...(opts.broadcast ? { reply_broadcast: true } : {}),
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
    } as never);
    return { channel: res.channel ?? opts.channel, ts: res.ts ?? '' };
  }

  async updateMessage(opts: UpdateOptions): Promise<void> {
    await this.client.chat.update({
      channel: opts.channel,
      ts: opts.ts,
      text: opts.text,
      ...(opts.blocks ? { blocks: opts.blocks } : {}),
    } as never);
  }

  async findChannelId(name: string): Promise<string | undefined> {
    let cursor: string | undefined;
    do {
      const res = await this.client.conversations.list({
        types: 'public_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      } as never);
      const hit = res.channels?.find((c) => c.name === name);
      if (hit?.id) return hit.id;
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return undefined;
  }

  async joinChannel(channelId: string): Promise<void> {
    await this.client.conversations.join({ channel: channelId } as never);
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function chunkLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max && current) {
      chunks.push(current);
      current = truncate(line, max);
    } else {
      current = candidate.length > max ? truncate(candidate, max) : candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
