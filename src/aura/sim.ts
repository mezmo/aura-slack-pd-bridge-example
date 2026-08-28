// Simulated aura: same event shapes as the real connector, filler text instead
// of an LLM. Exercises status updates, resume (per-session run counter), and
// the HITL approval loop — a prompt containing "node log" parks an approval
// until resolveApproval is called (or SIM approval timeout).
import type { AuraConnector, AuraEvent, AuraRunInput } from './connector.js';

const THINKING_STEPS = [
  'Planning investigation: 2 tasks dispatched to cluster_inspector',
  'cluster_inspector: listing pods in ruleprod-apps',
  'cluster_inspector: reading recent events (14 found)',
  'cluster_inspector: pulling logs from suspect pods',
  'Synthesizing findings from worker reports',
];

const FINDINGS = [
  'Root cause: the `cart` deployment is being OOMKilled — memory limit 128Mi is hit under load, container restarts every ~90s.',
  'Root cause: `checkout` cannot reach `orders` — DNS resolves but connections time out; the orders pods show CrashLoopBackOff after a failed migration.',
  'Root cause: elevated 5xx from `catalog` — connection pool exhaustion against Postgres; slow `price-quote` queries are holding connections.',
];

const APPROVAL_TRIGGER = /node ?logs?/i;
const APPROVAL_TIMEOUT_MS = 300_000;

interface PendingApproval {
  resolve: (approved: boolean) => void;
}

export class SimAuraConnector implements AuraConnector {
  readonly name = 'sim';
  private runCounts = new Map<string, number>();
  private pending = new Map<string, PendingApproval>();
  private decisionCounter = 0;

  constructor(private stepMs: number) {}

  async *run(input: AuraRunInput): AsyncGenerator<AuraEvent, void, void> {
    const runNumber = (this.runCounts.get(input.sessionId) ?? 0) + 1;
    this.runCounts.set(input.sessionId, runNumber);

    const lastUser = [...input.messages].reverse().find((m) => m.role === 'user');
    const prompt = typeof lastUser?.content === 'string' ? lastUser.content : '';

    if (runNumber > 1) {
      yield { kind: 'progress', message: `Resuming session ${input.sessionId} (run ${runNumber}, ${input.messages.length} messages of history)` };
    }
    let tokens = 0;
    for (const step of THINKING_STEPS) {
      await sleep(this.stepMs, input.signal);
      yield { kind: 'progress', message: step };
      tokens += 4200;
      yield { kind: 'usage', totalTokens: tokens };
    }

    let approvalNote = '';
    if (APPROVAL_TRIGGER.test(prompt)) {
      const decisionId = `sim-decision-${++this.decisionCounter}`;
      yield { kind: 'approval_pending', decisionId, toolName: 'nodes_log', args: { name: 'ip-10-0-1-23.ec2.internal', query: ['kubelet'] } };
      const approved = await this.awaitDecision(decisionId, input.signal);
      yield { kind: 'approval_completed', decisionId, outcome: approved ? 'approved' : 'denied' };
      if (!approved) {
        yield { kind: 'final', text: `The \`nodes_log\` call was denied, so I stopped there.\n\n${pick(FINDINGS, runNumber)}\n\n_(simulated response, run ${runNumber})_` };
        return;
      }
      await sleep(this.stepMs, input.signal);
      yield { kind: 'progress', message: 'cluster_inspector: reading kubelet logs from approved node' };
      approvalNote = 'Node kubelet logs confirm the container restarts line up with memory-cgroup OOM events.\n\n';
    }

    await sleep(this.stepMs, input.signal);
    yield {
      kind: 'final',
      text: `${approvalNote}${pick(FINDINGS, runNumber)}\n\nSuggested next step: raise the memory limit or fix the leak; happy to dig further.\n\n_(simulated response, run ${runNumber}, prompt was: "${truncate(prompt, 120)}")_`,
    };
  }

  async resolveApproval(decisionId: string, approved: boolean): Promise<boolean> {
    const pending = this.pending.get(decisionId);
    if (!pending) return false;
    this.pending.delete(decisionId);
    pending.resolve(approved);
    return true;
  }

  // Mirrors real aura, where a stream abort denies parked approvals: the run
  // dies with the abort reason instead of resolving the decision.
  private awaitDecision(decisionId: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError(signal));
      const timer = setTimeout(() => {
        this.pending.delete(decisionId);
        resolve(false);
      }, APPROVAL_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(decisionId);
        reject(abortError(signal!));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(decisionId, {
        resolve: (approved) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(approved);
        },
      });
    });
  }
}

const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('aborted');

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
const pick = <T>(arr: T[], seed: number): T => arr[seed % arr.length] as T;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
