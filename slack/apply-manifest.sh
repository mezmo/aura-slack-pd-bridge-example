#!/usr/bin/env bash
# Create or update the AURA Slack app from manifest.json.
# Slack app config is deliberately not Terraform: the manifest API needs a
# short-lived app-configuration token (api.slack.com/apps → Your App
# Configuration Tokens), and nothing else about the app changes often.
#
#   SLACK_CONFIG_TOKEN=xoxe... ./apply-manifest.sh            # create
#   SLACK_CONFIG_TOKEN=xoxe... ./apply-manifest.sh <app-id>   # update
#
# After create: install the app to the workspace (one click in the UI) for the
# bot token (xoxb-), and mint an app-level token with connections:write for
# Socket Mode (xapp-) — both go to Secrets Manager, never into this repo.
set -euo pipefail

cd "$(dirname "$0")"
: "${SLACK_CONFIG_TOKEN:?set SLACK_CONFIG_TOKEN (app configuration token, xoxe...)}"

manifest=$(cat manifest.json)
app_id="${1:-}"

if [ -z "$app_id" ]; then
  echo "creating app from manifest.json"
  response=$(curl -sf -X POST https://slack.com/api/apps.manifest.create \
    -H "Authorization: Bearer ${SLACK_CONFIG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"manifest\": $(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")
else
  echo "updating app ${app_id} from manifest.json"
  response=$(curl -sf -X POST https://slack.com/api/apps.manifest.update \
    -H "Authorization: Bearer ${SLACK_CONFIG_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\": \"${app_id}\", \"manifest\": $(printf '%s' "$manifest" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")
fi

echo "$response" | python3 -m json.tool
echo "$response" | python3 -c 'import json,sys; r=json.load(sys.stdin); sys.exit(0 if r.get("ok") else 1)'
