// Test doubles: RecordingSlack captures every SlackPort call; noopLogger
// satisfies the engine/server logger without output.
import type { FastifyBaseLogger } from 'fastify';
import type { PostedMessage, PostOptions, SlackPort, UpdateOptions } from '../src/outbound/slack.js';

export class RecordingSlack implements SlackPort {
  posts: Array<PostOptions & { ts: string }> = [];
  updates: UpdateOptions[] = [];
  joined: string[] = [];
  /** name -> channel id; findChannelId misses names not present. */
  channels = new Map<string, string>();
  findChannelIdCalls = 0;
  private counter = 0;

  async postMessage(opts: PostOptions): Promise<PostedMessage> {
    const ts = `ts-${++this.counter}`;
    this.posts.push({ ...opts, ts });
    return { channel: opts.channel, ts };
  }

  async updateMessage(opts: UpdateOptions): Promise<void> {
    this.updates.push(opts);
  }

  async findChannelId(name: string): Promise<string | undefined> {
    this.findChannelIdCalls += 1;
    return this.channels.get(name);
  }

  async joinChannel(channelId: string): Promise<void> {
    this.joined.push(channelId);
  }
}

const noop = (): void => {};
export const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  silent: noop,
  level: 'silent',
  child() {
    return this;
  },
} as unknown as FastifyBaseLogger;

export async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
