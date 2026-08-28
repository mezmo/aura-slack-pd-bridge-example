// TUI for the bridge admin API — deliberately a dumb menu over HTTP.
// Local: `npm run tui -w @ruleprod/aura-bridge` (BRIDGE_URL to override target).
// In-cluster (compiled to dist/tui.js via tsconfig.tui.json, shipped in the image):
//   kubectl exec -n aura-bridge -it deploy/aura-bridge -- node dist/tui
//   (note: namespace and deployment name may vary)
import { createInterface } from 'node:readline/promises';

const base = process.env.BRIDGE_URL ?? 'http://localhost:3000';
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function show(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

const MENU = `
aura-bridge TUI (${base})
  1) status
  2) toggle aura mode (real/sim)
  3) trigger fake PD incident
  4) send fake @mention (resume/fork without Slack)
  5) send test Slack message
  6) send test approval buttons
  7) decide a pending approval
  8) stop the active run for an incident
  q) quit
`;

let lastChannel = process.env.BRIDGE_CHANNEL ?? 'C-test-incident';

async function main(): Promise<void> {
  for (;;) {
    console.log(MENU);
    const choice = (await rl.question('> ')).trim();
    try {
      switch (choice) {
        case '1':
          show(await api('GET', '/admin/status'));
          break;
        case '2': {
          const status = (await api('GET', '/admin/status')) as { auraMode?: string };
          const mode = status.auraMode === 'sim' ? 'real' : 'sim';
          show(await api('POST', '/admin/aura/mode', { mode }));
          break;
        }
        case '3': {
          lastChannel = (await rl.question(`channel id [${lastChannel}]: `)).trim() || lastChannel;
          const title = (await rl.question('title [Fake incident]: ')).trim() || undefined;
          show(await api('POST', '/admin/pd-incident', { channelId: lastChannel, title }));
          break;
        }
        case '4': {
          lastChannel = (await rl.question(`channel id [${lastChannel}]: `)).trim() || lastChannel;
          const text = await rl.question('mention text: ');
          const threadTs = (await rl.question('thread ts (empty = channel): ')).trim() || undefined;
          show(await api('POST', '/admin/mention', { channelId: lastChannel, text, threadTs }));
          break;
        }
        case '5': {
          lastChannel = (await rl.question(`channel [${lastChannel}]: `)).trim() || lastChannel;
          const text = await rl.question('text: ');
          show(await api('POST', '/admin/slack/post', { channel: lastChannel, text }));
          break;
        }
        case '6': {
          lastChannel = (await rl.question(`channel [${lastChannel}]: `)).trim() || lastChannel;
          show(await api('POST', '/admin/slack/approval', { channel: lastChannel }));
          break;
        }
        case '7': {
          const decisionId = (await rl.question('decision id: ')).trim();
          const approved = (await rl.question('approve? [y/N]: ')).trim().toLowerCase() === 'y';
          show(await api('POST', '/admin/approval/decide', { decisionId, approved }));
          break;
        }
        case '8': {
          const incidentId = (await rl.question('incident id (see status "busy"): ')).trim();
          show(await api('POST', '/admin/stop', { incidentId }));
          break;
        }
        case 'q':
          rl.close();
          return;
        default:
          break;
      }
    } catch (err) {
      console.error(`request failed: ${(err as Error).message}`);
    }
  }
}

await main();
