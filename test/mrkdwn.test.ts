import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn } from '../src/outbound/mrkdwn.js';

describe('markdownToMrkdwn', () => {
  it('converts headings to bold lines', () => {
    expect(markdownToMrkdwn('## Findings\ntext')).toBe('*Findings*\ntext');
  });

  it('converts bold and italic', () => {
    expect(markdownToMrkdwn('**bold** and *italic* words')).toBe('*bold* and _italic_ words');
    expect(markdownToMrkdwn('__bold__ too')).toBe('*bold* too');
  });

  it('converts list markers without eating emphasis', () => {
    expect(markdownToMrkdwn('- item one\n* item two')).toBe('• item one\n• item two');
    expect(markdownToMrkdwn('* item with *emphasis* inside')).toBe('• item with _emphasis_ inside');
  });

  it('converts links', () => {
    expect(markdownToMrkdwn('see [the dashboard](https://g.example/d/1) now')).toBe(
      'see <https://g.example/d/1|the dashboard> now',
    );
  });

  it('leaves inline code and fences untouched', () => {
    expect(markdownToMrkdwn('run `kubectl get pods` now')).toBe('run `kubectl get pods` now');
    const fenced = 'before **b**\n```\n## not a heading\n**not bold**\n```\nafter **b**';
    expect(markdownToMrkdwn(fenced)).toBe('before *b*\n```\n## not a heading\n**not bold**\n```\nafter *b*');
  });

  it('does not mangle multiplication or mid-word asterisks', () => {
    expect(markdownToMrkdwn('memory 55Mi * 2 replicas')).toBe('memory 55Mi * 2 replicas');
  });

  it('handles a realistic aura answer shape', () => {
    const md = '## Incident X — Findings\n\n**Bottom line:** healthy.\n\n### Evidence\n- **Pod status:** `cart-abc` is **Running**\n- restartCount = 0';
    expect(markdownToMrkdwn(md)).toBe(
      '*Incident X — Findings*\n\n*Bottom line:* healthy.\n\n*Evidence*\n• *Pod status:* `cart-abc` is *Running*\n• restartCount = 0',
    );
  });
});
