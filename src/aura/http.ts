// Real aura connector over /v1/chat/completions SSE. Holds the stream open for
// the life of the run — aura fail-closes on disconnect (cancels the run and
// denies parked approvals), so never abort early except on caller error or a
// deliberate stop: input.signal leans on exactly that fail-close as the cancel
// mechanism (aura has no cancel endpoint).
// Event mapping is defensive: aura.* payload shapes vary by event; missing
// fields decode to empty/undefined rather than failing the run.
import type { AuraConnector, AuraEvent, AuraRunInput, OrchestrationUpdate } from './connector.js';

export class HttpAuraConnector implements AuraConnector {
  readonly name = 'real';

  constructor(private baseUrl: string) {}

  async *run(input: AuraRunInput): AsyncGenerator<AuraEvent, void, void> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: input.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: input.messages,
        stream: true,
        metadata: { chat_session_id: input.sessionId },
      }),
    });
    if (!res.ok || !res.body) {
      yield { kind: 'error', message: `aura returned ${res.status}: ${truncate(await res.text(), 300)}` };
      return;
    }

    let assistantText = '';
    let finished = false;
    for await (const frame of sseFrames(res.body)) {
      if (frame.data === '[DONE]') {
        finished = true;
        break;
      }
      const payload = tryJson(frame.data);
      if (payload === undefined) continue;

      if (!frame.event) {
        // OpenAI chat.completion.chunk
        const delta = (payload as ChunkPayload).choices?.[0]?.delta?.content;
        if (typeof delta === 'string') assistantText += delta;
        continue;
      }

      const ev = mapAuraEvent(frame.event, payload as Record<string, unknown>);
      if (ev) yield ev;
    }

    if (finished) {
      yield { kind: 'final', text: assistantText };
    } else {
      yield { kind: 'error', message: 'aura stream ended without [DONE]' };
    }
  }

  async resolveApproval(decisionId: string, approved: boolean, reason?: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/v1/approvals/${encodeURIComponent(decisionId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(approved ? { approved: true } : { approved: false, reason: reason ?? 'denied via Slack' }),
    });
    // 404 = unknown, expired, or already resolved.
    return res.status === 204;
  }
}

interface ChunkPayload {
  choices?: Array<{ delta?: { content?: unknown } }>;
}

function mapAuraEvent(event: string, p: Record<string, unknown>): AuraEvent | undefined {
  switch (event) {
    case 'aura.approval_pending':
      return {
        kind: 'approval_pending',
        decisionId: str(p.decision_id),
        toolName: str(p.tool_name),
        args: p.arguments,
      };
    case 'aura.approval_requested':
      return undefined; // approval_pending follows with the full payload
    case 'aura.approval_completed':
      return { kind: 'approval_completed', decisionId: str(p.decision_id), outcome: outcomeText(p.outcome) };
    case 'aura.progress':
      return { kind: 'progress', message: str(p.message ?? p.status ?? p.detail, 'working…') };
    case 'aura.reasoning':
      // Streamed as tiny deltas — thousands per run, each meaningless alone.
      return undefined;
    case 'aura.tool_start':
      return { kind: 'tool_activity', phase: 'started', toolName: str(p.tool_name ?? p.name, '?') };
    case 'aura.tool_complete':
      return { kind: 'tool_activity', phase: 'finished', toolName: str(p.tool_name ?? p.name, '?') };
    case 'aura.worker_phase':
      return { kind: 'progress', message: str(p.phase ?? p.message, 'worker phase') };
    case 'aura.tool_usage':
    case 'aura.usage': {
      const total = typeof p.total_tokens === 'number' ? p.total_tokens : Number(p.total_tokens);
      return Number.isFinite(total) && total > 0 ? { kind: 'usage', totalTokens: total } : undefined;
    }
    default:
      if (event.startsWith('aura.orchestrator.')) return mapOrchestratorEvent(event, p);
      return undefined; // session_info, usage, mcp_status, ... — not user-facing
  }
}

// Payload shapes per aura-events orchestration.rs. Decode only — no prose.
function mapOrchestratorEvent(event: string, p: Record<string, unknown>): AuraEvent | undefined {
  const orch = (update: OrchestrationUpdate): AuraEvent => ({ kind: 'orchestration', update });
  const task = (): { taskId?: number | string; workerId?: string } => ({
    ...(typeof p.task_id === 'number' || typeof p.task_id === 'string' ? { taskId: p.task_id } : {}),
    ...(typeof p.worker_id === 'string' ? { workerId: p.worker_id } : {}),
  });

  switch (event.slice('aura.orchestrator.'.length)) {
    case 'plan_created':
      return orch({ type: 'plan_created', goal: str(p.goal) });
    case 'direct_answer':
      return orch({ type: 'direct_answer' });
    case 'replan_started':
      return orch({ type: 'replan_started', trigger: str(p.trigger) });
    case 'synthesizing':
      return orch({ type: 'synthesizing' });
    case 'task_started':
      return orch({ type: 'task_started', ...task(), description: str(p.description) });
    case 'worker_reasoning':
      // Just the fact — p.content (the reasoning words) is dropped here.
      return orch({ type: 'worker_reasoning', ...task() });
    case 'tool_call_started':
      return orch({ type: 'tool_call_started', ...task(), toolName: str(p.tool_name), args: p.arguments });
    case 'task_completed':
      return orch({ type: 'task_completed', ...task(), success: p.success !== false });
    default:
      return undefined; // tool_call_completed (no timings), iteration/phase bookkeeping
  }
}

function outcomeText(outcome: unknown): string {
  if (typeof outcome === 'string') return outcome;
  if (outcome && typeof outcome === 'object') return Object.keys(outcome)[0] ?? 'unknown';
  return 'unknown';
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

interface SseFrame {
  event?: string;
  data: string;
}

/** Minimal SSE parser: yields {event?, data} per frame, ignores comments/heartbeats. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame, void, void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseFrame | undefined => {
    if (dataLines.length === 0) {
      event = undefined;
      return undefined;
    }
    const frame: SseFrame = { event, data: dataLines.join('\n') };
    event = undefined;
    dataLines = [];
    return frame;
  };

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (line === '') {
        const frame = flush();
        if (frame) yield frame;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
      // ':' comment lines (heartbeats) fall through
    }
  }
  const frame = flush();
  if (frame) yield frame;
}
