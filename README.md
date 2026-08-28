# Example Service for PagerDuty / Slack / AURA automation

Reference "bridge" repo from the E2E [AURA](https://github.com/mezmo/aura) → Slack automated incident response workflow demo.

> - AURA on GitHub: **[mezmo/aura](https://github.com/mezmo/aura)** · [Quick Start](https://github.com/mezmo/aura#quick-start) · [Docs](https://docs.mezmo.com/aura) · [Kubernetes SRE quickstart](https://docs.mezmo.com/aura/quickstart-k8s-sre)
> - Questions or feedback: [open an issue](https://github.com/mezmo/aura/issues), [send us an email](mailto:info@mezmo.com), or join the [AURA Community Slack](https://auracommunitygroup.slack.com)
> - Want to just experiment with AURA? No need for this repo, just `brew install mezmo/tap/aura`, run `aura init`, connect an MCP server, and start asking questions about your environment.

## What this is

This is the bridge service from the E2E incident automation demo, published for reference. It works, and you can use it or fork it, but it was built for a demo, not as a supported product: it carries no maintenance promise and no warranty (see [LICENSE](LICENSE), Apache 2.0).

## Prerequisites

1. AURA hosted on a k8s cluster, configured with appropriate MCP servers and workers.
2. A PagerDuty workflow which can create a dedicated Slack incident channel.
3. A Slack App created with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.

## Running this Service and connecting to PagerDuty
1. Host this service on a k8s cluster with an Ingress (optionally restricted to PagerDuty [safelist IPs](https://support.pagerduty.com/main/docs/safelist-ips)). Example manifests are in [`k8s/`](k8s): Deployment (single replica by design — run state is in-process), Service, and an Ingress that exposes only `/webhooks`. Build the image from the [Dockerfile](Dockerfile).
2. Configure the PagerDuty workflow to send a POST request to `http(s)://<ingress endpoint>/webhooks/pagerduty`. Add the `X-Bridge-Token` header (its value must match the bridge's `PD_WEBHOOK_TOKEN`), and a body with the following fields:

```json
{"incidentId":"{{incident.id}}","incidentNumber":"{{incident.incident_number}}","channelId":"{{steps['Create Incident Dedicated Channel'].fields['Channel ID']}}","title":"{{incident.title}}"}
```

## What the service does

1. New PagerDuty incidents trigger the bridge service to start an AURA investigation
2. The Slackbot joins the channel, posts "AURA is investigating…", and live-edits that message with the orchestration task board (coordinator plan, per-worker tool calls, token totals). The full answer posts when the run completes.
3. Follow-ups: @mention the bot in-channel to resume the investigation's main line; reply in a thread under an earlier answer to fork from that answer's context.
4. When AURA requests human-in-the-loop approval for a guarded tool, the bridge posts approve/deny buttons; the decision resumes the run.

## Architecture

```
PagerDuty ─webhook─▶ ┌────────────── aura-bridge ──────────────┐      ┌──────┐
                     │ triggers ─▶ control ─▶ aura connector   │─SSE─▶│ aura │
Slack ◀──Web API──── │              │         (real | sim)     │      └──────┘
      ─Socket Mode─▶ │         admin API ◀── tools/tui.ts      │
                     └─────────────────────────────────────────┘
```

- [`src/triggers/`](src/triggers) — inbound: PD v3 webhook (signature-verified), Slack Socket Mode events (mentions, button actions). Never business logic.
- [`src/control/`](src/control) — conversation tree per incident, per-incident FIFO queue, investigation lifecycle, approver gate (stubbed allow-all, mechanism in place).
- [`src/aura/`](src/aura) — `AuraConnector` interface; [`http.ts`](src/aura/http.ts) streams AURA's OpenAI-compatible completions SSE, [`sim.ts`](src/aura/sim.ts) is a canned simulator (no LLM, no tokens). Swap via `AURA_MODE=real|sim` or the admin API. Connectors decode wire events into structured facts; no user-facing text.
- [`src/outbound/`](src/outbound) — Slack Web API port, Block Kit builders, markdown→mrkdwn, and [`status.ts`](src/outbound/status.ts): the presenter that turns connector events into the live status message (task board, totals, Stop button).
- [`src/admin/`](src/admin) — localhost-only API: inject a fake PD webhook, resolve approvals, toggle sim mode.
- [`tools/tui.ts`](tools/tui.ts) — menu-driven TUI over the admin API: `npm run tui` (`BRIDGE_URL` to override the target).
- [`slack/manifest.json`](slack/manifest.json) — the Slack app manifest (scopes, Socket Mode, event subscriptions) for wiring a real workspace.

Each layer is independently exercisable: test a Slack post without AURA, replay a PD webhook without an incident, run a full investigation against the simulator without tokens.

## Testing

Everything defaults to a token-less local setup: simulated AURA, console-logged Slack, unauthenticated webhooks.

```bash
npm install
npm run dev
```

Then drive it from a second terminal with `npm run tui` (inject a fake incident, watch the "Slack" messages appear in the server log). `npm test` runs the full choreography against the simulator.

## Environment variables

See [`src/config.ts`](src/config.ts) for the full list and defaults.

- `AURA_MODE=real` + `AURA_URL` — point at an AURA web server's completions endpoint.
- `SLACK_MODE=real` + `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` — real workspace over Socket Mode (create the app from `slack/manifest.json`).
- `PD_WEBHOOK_SECRET` or `PD_WEBHOOK_TOKEN` — webhook authentication; unset accepts unauthenticated posts, local dev only.
- `CHANNEL_NAME_PATTERN` — incident channel naming (`{number}` = PD incident number); must match the PD workflow's "Create a Slack Channel" action.
- `STATE_FILE` — persist the conversation tree across restarts; unset keeps state in memory.
