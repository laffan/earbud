import { describe, expect, it } from 'vitest';
import { isEmojiOnly, renderInline, renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders the inline marks', () => {
    expect(renderInline('**loud** and *soft*, _very_ ~~not~~ `C7#9`')).toBe(
      '<strong>loud</strong> and <em>soft</em>, <em>very</em> <del>not</del> <code>C7#9</code>',
    );
    // Underscores and asterisks inside words, and arithmetic, stay as they are.
    expect(renderInline('snake_case_name and 3 * 4 * 5')).toBe('snake_case_name and 3 * 4 * 5');
    expect(renderInline('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('makes links only to the web and mail', () => {
    expect(renderInline('[score](https://example.com/a?b=1&c=2)')).toBe(
      '<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">score</a>',
    );
    expect(renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });

  it('never lets markup through', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n**<script>bad()</script>**');
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('renders the blocks a note needs', () => {
    const html = renderMarkdown(
      [
        '# Bridge',
        'Try it slower',
        'in D minor',
        '',
        '- intro',
        '- [x] verse',
        '- [ ] chorus',
        '',
        '1. one',
        '2. two',
        '> keep the pedal down',
        '---',
        '```',
        'C - Am - F',
        '```',
      ].join('\n'),
    );
    expect(html).toBe(
      '<h1>Bridge</h1>' +
        '<p>Try it slower<br>in D minor</p>' +
        '<ul><li>intro</li><li><span class="task">☑</span> verse</li><li><span class="task">☐</span> chorus</li></ul>' +
        '<ol><li>one</li><li>two</li></ol>' +
        '<blockquote>keep the pedal down</blockquote>' +
        '<hr>' +
        '<pre><code>C - Am - F</code></pre>',
    );
  });
});

describe('isEmojiOnly', () => {
  it('recognises emoji on their own', () => {
    for (const text of ['🎹', ' 🔥 ', '👍🏽', '🇫🇷', '👩‍🎤', '🎸🥁', '❤️']) expect(isEmojiOnly(text), text).toBe(true);
  });
  it('not text, numbers, or emoji with words', () => {
    for (const text of ['', '  ', 'ok', '123', '#1', 'great 🎹', '🎹!']) expect(isEmojiOnly(text), text).toBe(false);
  });
});
