import { describe, it, expect } from 'vitest';
import { renderDocMarkdown, splitCallouts } from '../src/markdown.js';

describe('splitCallouts', () => {
  it('peels a callout out of the prose around it', () => {
    const blocks = splitCallouts('Before.\n\n:::info\nInside.\n:::\n\nAfter.\n');
    expect(blocks.map((b) => b.kind)).toEqual([null, 'info', null]);
    expect(blocks[1].markdown).toBe('Inside.');
    expect(blocks[2].markdown.trim()).toBe('After.');
  });

  it('keeps the title the author wrote, and leaves it empty when there is none', () => {
    const [titled] = splitCallouts(':::warning Mind the gap\nBody.\n:::');
    expect(titled.title).toBe('Mind the gap');
    expect(splitCallouts(':::tip\nBody.\n:::')[0].title).toBe('');
  });

  it('knows its five kinds and treats anything else as prose', () => {
    const kinds = splitCallouts(
      ':::info\na\n:::\n:::tip\nb\n:::\n:::note\nc\n:::\n:::warning\nd\n:::\n:::danger\ne\n:::',
    );
    expect(kinds.map((b) => b.kind)).toEqual(['info', 'tip', 'note', 'warning', 'danger']);
    expect(splitCallouts(':::sidebar\nnope\n:::').map((b) => b.kind)).toEqual([null]);
  });

  it('leaves a ::: inside a fenced code block alone', () => {
    const blocks = splitCallouts('```\n:::info\nnot a callout\n:::\n```\n');
    expect(blocks.map((b) => b.kind)).toEqual([null]);
    expect(blocks[0].markdown).toContain(':::info');
  });

  it('runs an unclosed callout to the end of the document', () => {
    const blocks = splitCallouts(':::danger\nStill open.\nAnd more.');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('danger');
    expect(blocks[0].markdown).toBe('Still open.\nAnd more.');
  });

  it('has one plain block for a document with no callouts, and none for an empty one', () => {
    expect(splitCallouts('# Title\n\nText.').map((b) => b.kind)).toEqual([null]);
    expect(splitCallouts('   \n')).toEqual([]);
  });
});

describe('renderDocMarkdown', () => {
  it('wraps a callout in an aside with its kind, an icon and a label', () => {
    const html = renderDocMarkdown(':::warning\nBe careful.\n:::');
    expect(html).toContain('<aside class="adm adm--warning" role="note">');
    expect(html).toContain('<svg class="adm__icon"');
    expect(html).toContain('<span>Warning</span>');
    expect(html).toContain('<p>Be careful.</p>');
  });

  it('labels a callout with the author’s title when there is one', () => {
    expect(renderDocMarkdown(':::info Read this first\nx\n:::')).toContain('<span>Read this first</span>');
  });

  it('renders markdown inside the callout body', () => {
    const html = renderDocMarkdown(':::tip\n- one\n- two\n:::');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
  });

  it('escapes the title and the body, like the plain renderer does', () => {
    const html = renderDocMarkdown(':::danger <img src=x onerror=alert(1)>\n<script>bad()</script>\n:::');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders a document with no callouts exactly as the plain renderer would', () => {
    expect(renderDocMarkdown('# Title\n\nText.')).toBe('<h1 id="md-title">Title</h1>\n<p>Text.</p>');
  });
});
