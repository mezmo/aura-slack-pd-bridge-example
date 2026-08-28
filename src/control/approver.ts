// Button permission gate. Deliberately allow-all for now — the mechanism is
// what matters: every interactive click (approve/deny/stop) flows through here
// with its action name, so per-button rules later (Slack usergroup lookup,
// per-incident responder list, "anyone may stop but only responders approve")
// are one function.
import type { Incident } from './store.js';

export type ButtonAction = 'approve' | 'deny' | 'stop';

export function authorizeButton(
  _action: ButtonAction,
  _slackUserId: string,
  _incident: Incident | undefined,
): boolean {
  return true;
}
