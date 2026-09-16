import { describe, it, expect } from 'vitest';
import { escapeHtml, headingId, renderMarkdown } from '../src/markdown.js';

describe('escapeHtml', () => {
  it('neutralises the four characters that can start markup or break an attribute', () => {
    expect(escapeHtml('& < > "')).toBe('&amp; &lt; &gt; &quot;');
  });

  it('escapes the ampersand once, not twice', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderMarkdown — hostile input', () => {
  it('never lets a raw tag through', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes an inline event-handler payload rather than rendering the element', () => {
    const html = renderMarkdown('hello <img src=x onerror="alert(1)"> there');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('refuses a javascript: link and leaves the source text visible instead', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href');
    expect(html).toContain('[x](javascript:alert(1))');
  });

  it('refuses data: and protocol-relative targets too', () => {
    for (const url of ['data:text/html,<script>x</script>', 'vbscript:x', '//evil.example/x']) {
      const html = renderMarkdown(`[go](${url})`);
      expect(html, url).not.toContain('<a ');
    }
  });

  it('cannot be talked out of the href quoting by a quote in the url', () => {
    const html = renderMarkdown('[x](/a" onmouseover="alert(1))');
    expect(html).not.toContain('onmouseover="alert');
    expect(html).toContain('&quot;');
  });

  it('treats an unclosed fence as code to the end of the document', () => {
    const html = renderMarkdown('```\n<script>alert(1)</script>\nstill code');
    expect(html).toBe('<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\nstill code</code></pre>');
  });

  it('does not format inside a fenced block', () => {
    const html = renderMarkdown('```\n# not a heading **not bold**\n```');
    expect(html).not.toContain('<h1');
    expect(html).not.toContain('<strong>');
  });

  it('escapes html that arrives inside a table cell or a heading', () => {
    expect(renderMarkdown('# <b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(renderMarkdown('| a |\n| --- |\n| <b>x</b> |')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('renderMarkdown — supported syntax', () => {
  it('renders ATX headings h1–h4 with an id, and nothing deeper', () => {
    expect(renderMarkdown('# Goals')).toBe('<h1 id="md-goals">Goals</h1>');
    expect(renderMarkdown('#### Risks')).toBe('<h4 id="md-risks">Risks</h4>');
    expect(renderMarkdown('##### Too deep')).toBe('<p>##### Too deep</p>');
  });

  it('renders a fenced block, keeping its newlines', () => {
    expect(renderMarkdown('```ts\nconst a = 1;\nconst b = 2;\n```'))
      .toBe('<pre><code>const a = 1;\nconst b = 2;</code></pre>');
  });

  it('renders inline code, bold and italic', () => {
    expect(renderMarkdown('use `npm test`')).toBe('<p>use <code>npm test</code></p>');
    expect(renderMarkdown('**very** and *quite* and _also_'))
      .toBe('<p><strong>very</strong> and <em>quite</em> and <em>also</em></p>');
  });

  it('leaves underscores inside a word alone', () => {
    expect(renderMarkdown('call project_slug_name')).toBe('<p>call project_slug_name</p>');
  });

  it('renders unordered and ordered lists, with one level of nesting', () => {
    expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('- one\n  - deep\n- two'))
      .toBe('<ul><li>one<ul><li>deep</li></ul></li><li>two</li></ul>');
  });

  it('keeps a list together across a single blank line', () => {
    expect(renderMarkdown('- one\n\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('renders a simple pipe table, padding a short row', () => {
    const html = renderMarkdown('| Name | Owner |\n| --- | --- |\n| Alpha | Ana |\n| Beta |');
    expect(html).toContain('<th>Name</th><th>Owner</th>');
    expect(html).toContain('<td>Alpha</td><td>Ana</td>');
    expect(html).toContain('<td>Beta</td><td></td>');
  });

  it('links only to the web, a fragment, or this site', () => {
    expect(renderMarkdown('[a](https://example.com)'))
      .toBe('<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">a</a></p>');
    expect(renderMarkdown('[a](/local)')).toContain('href="/local"');
    expect(renderMarkdown('[a](#goals)')).toContain('href="#goals"');
    expect(renderMarkdown('[a](mailto:x@y.z)')).not.toContain('<a ');
  });

  it('joins a paragraph and splits on the blank line', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe('<p>one two</p>\n<p>three</p>');
  });

  it('has nothing to say about an empty document', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('\n\n  \n')).toBe('');
  });
});

describe('headingId', () => {
  it('agrees between the escaped document and the hub’s raw section name', () => {
    expect(headingId('Goals & scope')).toBe(headingId('Goals &amp; scope'));
    expect(headingId('Goals & scope')).toBe('md-goals-scope');
  });

  it('falls back rather than producing an empty id', () => {
    expect(headingId('???')).toBe('md-section');
  });
});
