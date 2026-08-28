// Markdown → Slack mrkdwn. Aura answers in standard markdown, which Slack
// renders literally (## headers, **bold**). Conversion lives in the bridge —
// deterministic, model-independent — instead of prompting aura for Slack
// syntax, which would drift and break other consumers of aura's output.
const BOLD_TOKEN = '\u0000B\u0000'; // null bytes never occur in model output

export function markdownToMrkdwn(md: string): string {
  // Code fences pass through untouched; transform only prose segments.
  return md
    .split(/(```[\s\S]*?```)/)
    .map((segment) => (segment.startsWith('```') ? segment : transformProse(segment)))
    .join('');
}

function transformProse(text: string): string {
  const lines = text.split('\n').map((line) => {
    // Bullets before italics: a leading "* " is a list marker, not emphasis.
    line = line.replace(/^(\s*)[*-]\s+/, '$1• ');
    // Headings become bold lines.
    line = line.replace(/^#{1,6}\s+(.*)$/, `${BOLD_TOKEN}$1${BOLD_TOKEN}`);
    return line;
  });
  let out = lines.join('\n');
  // Bold via token so the italic pass below can't see the doubled asterisks.
  out = out.replace(/\*\*(.+?)\*\*/g, `${BOLD_TOKEN}$1${BOLD_TOKEN}`);
  out = out.replace(/__(.+?)__/g, `${BOLD_TOKEN}$1${BOLD_TOKEN}`);
  // Remaining single-asterisk emphasis (not inside words) → underscores.
  out = out.replace(/(^|[\s(])\*([^*\n]+?)\*(?=$|[\s).,;:!?])/gm, '$1_$2_');
  // Links: [text](url) → <url|text>.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  return out.replaceAll(BOLD_TOKEN, '*');
}
