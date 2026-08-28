// Per-key FIFO. One aura session id per incident means runs within an incident
// must never overlap (shared MCP session header); different incidents run
// concurrently.
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  private depths = new Map<string, number>();

  /** True if a run for this key is in flight or queued. */
  isBusy(key: string): boolean {
    return (this.depths.get(key) ?? 0) > 0;
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);
    const tail = this.tails.get(key) ?? Promise.resolve();
    const result = tail.then(async () => {
      try {
        return await task();
      } finally {
        // Decrement before result settles so isBusy() is accurate the moment
        // a caller's await returns.
        const depth = (this.depths.get(key) ?? 1) - 1;
        if (depth <= 0) this.depths.delete(key);
        else this.depths.set(key, depth);
      }
    });
    const next = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, next);
    void next.then(() => {
      if (this.tails.get(key) === next && !this.isBusy(key)) this.tails.delete(key);
    });
    return result;
  }
}
