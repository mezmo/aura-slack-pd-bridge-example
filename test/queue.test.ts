import { describe, expect, it } from 'vitest';
import { KeyedQueue } from '../src/control/queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedQueue', () => {
  it('serializes tasks per key in FIFO order', async () => {
    const q = new KeyedQueue();
    const order: number[] = [];
    const t1 = q.run('a', async () => {
      await sleep(20);
      order.push(1);
    });
    const t2 = q.run('a', async () => {
      order.push(2);
    });
    expect(q.isBusy('a')).toBe(true);
    await Promise.all([t1, t2]);
    expect(order).toEqual([1, 2]);
    expect(q.isBusy('a')).toBe(false);
  });

  it('runs different keys concurrently', async () => {
    const q = new KeyedQueue();
    const order: string[] = [];
    const slow = q.run('a', async () => {
      await sleep(30);
      order.push('a');
    });
    const fast = q.run('b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });

  it('keeps the queue alive after a task throws', async () => {
    const q = new KeyedQueue();
    await expect(q.run('a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const result = await q.run('a', async () => 'ok');
    expect(result).toBe('ok');
    expect(q.isBusy('a')).toBe(false);
  });
});
