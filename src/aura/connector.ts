// AuraConnector: the seam between bridge control logic and aura. Two
// implementations — http.ts (real aura web server) and sim.ts (canned runs,
// no LLM) — so everything downstream is testable without tokens or a cluster.
//
// Contract mirrors aura's /v1/chat/completions SSE semantics: the server is
// stateless per request (full messages[] resent each run), and the session id
// keys aura's orchestration run store — reuse it across runs of one incident,
// never across two concurrent runs.
//
// Events carry facts (what aura did), not rendered text: connectors decode the
// wire format, outbound/status.ts turns events into the Slack status message.
// Neither side knows the other's format.

/** OpenAI-shaped chat message. Extra fields (tool_calls, tool_call_id, ...)
 * must survive round-trips untouched — aura's scratchpad file pointers live in
 * role:"tool" messages. */
export interface ChatMessage {
  role: string;
  content: string | null;
  [key: string]: unknown;
}

/** One orchestration actor's move. taskId absent = the coordinator (also the
 * defensive fallback when a payload omits task_id). Task ids restart at 0 on
 * every replan wave, so taskId alone never identifies a task across a run. */
export type OrchestrationUpdate =
  | { type: 'plan_created'; goal: string }
  | { type: 'direct_answer' }
  | { type: 'replan_started'; trigger: string }
  | { type: 'synthesizing' }
  | { type: 'task_started'; taskId?: number | string; workerId?: string; description: string }
  /** The fact that a worker is reasoning — deliberately never the words. */
  | { type: 'worker_reasoning'; taskId?: number | string; workerId?: string }
  | { type: 'tool_call_started'; taskId?: number | string; workerId?: string; toolName: string; args: unknown }
  | { type: 'task_completed'; taskId?: number | string; workerId?: string; success: boolean };

export type AuraEvent =
  /** Free-text progress from aura (aura.progress, worker phases). */
  | { kind: 'progress'; message: string }
  /** Top-level (non-orchestrated) tool activity. */
  | { kind: 'tool_activity'; phase: 'started' | 'finished'; toolName: string }
  | { kind: 'orchestration'; update: OrchestrationUpdate }
  /** Per-LLM-call token snapshot — a liveness signal during quiet stretches. */
  | { kind: 'usage'; totalTokens: number }
  | { kind: 'approval_pending'; decisionId: string; toolName: string; args: unknown }
  | { kind: 'approval_completed'; decisionId: string; outcome: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string };

export interface AuraRunInput {
  sessionId: string;
  messages: ChatMessage[];
  /** Abort = the supported stop path: aura fail-closes on stream disconnect
   * (cancels the run and its MCP calls, denies parked approvals). The run
   * iterator then throws; the engine renders it as user-stopped. */
  signal?: AbortSignal;
}

export interface AuraConnector {
  readonly name: string;
  /** One investigation run. The iterator ends after 'final' or 'error'. */
  run(input: AuraRunInput): AsyncGenerator<AuraEvent, void, void>;
  /** Answer a parked approval. Resolves false if the decision is unknown/expired. */
  resolveApproval(decisionId: string, approved: boolean, reason?: string): Promise<boolean>;
}
