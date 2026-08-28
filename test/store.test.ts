import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IncidentStore } from '../src/control/store.js';

describe('IncidentStore', () => {
  it('upsert is idempotent per incident id', () => {
    const store = new IncidentStore();
    const a = store.upsertIncident({ id: 'P1', channelId: 'C1' });
    const b = store.upsertIncident({ id: 'P1', channelId: 'C-other' });
    expect(b).toBe(a);
    expect(a.sessionId).toBe('pd-P1');
  });

  it('tracks main-line tip and finds fork parents by slack ts', () => {
    const store = new IncidentStore();
    const incident = store.upsertIncident({ id: 'P2', channelId: 'C2' });

    const root = store.addNode(incident, {
      messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }],
      slackTs: 'ts-root',
      mainLine: true,
    });
    expect(incident.tipNodeId).toBe(root.id);

    const followup = store.addNode(incident, {
      parentId: root.id,
      messages: [...root.messages, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }],
      slackTs: 'ts-2',
      mainLine: true,
    });
    expect(incident.tipNodeId).toBe(followup.id);

    // Thread fork from the root answer: parent resolves by slack ts, tip untouched.
    const forkParent = store.findNodeBySlackTs(incident, 'ts-root');
    expect(forkParent?.id).toBe(root.id);
    store.addNode(incident, {
      parentId: forkParent?.id,
      messages: [...root.messages, { role: 'user', content: 'thread q' }, { role: 'assistant', content: 'thread a' }],
      slackTs: 'ts-3',
      mainLine: false,
    });
    expect(incident.tipNodeId).toBe(followup.id);
  });

  it('finds incidents by channel', () => {
    const store = new IncidentStore();
    store.upsertIncident({ id: 'P3', channelId: 'C3' });
    expect(store.findByChannel('C3')?.id).toBe('P3');
    expect(store.findByChannel('C-none')).toBeUndefined();
  });

  describe('snapshots', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aura-bridge-test-'));
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('round-trips state through the snapshot file', () => {
      const file = join(dir, 'state.json');
      const store = new IncidentStore(file);
      const incident = store.upsertIncident({ id: 'P4', channelId: 'C4', title: 't' });
      store.addNode(incident, {
        messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
        slackTs: 'ts-1',
        mainLine: true,
      });
      store.saveNow();

      const reloaded = new IncidentStore(file);
      reloaded.load();
      const back = reloaded.getIncident('P4');
      expect(back?.channelId).toBe('C4');
      expect(back?.tipNodeId).toBeDefined();
      expect(Object.keys(back?.nodes ?? {})).toHaveLength(1);
    });
  });
});
