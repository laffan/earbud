/**
 * Markdown for text notes on the canvas: a small renderer that escapes
 * everything first and only ever emits a fixed set of tags, so a note can
 * never inject markup or script.
 *
 * Blocks: headings (#–###, deeper ones as ###), paragraphs (a single line
 * break stays a line break: notes are written line by line), bullet and
 * numbered lists, task lists (- [ ] / - [x]), quotes, fenced code, and rules.
 * Inline: `code`, **bold**, *italic* / _italic_, ~~strike~~, and
 * [links](https://…) (http, https and mailto only).
 */

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Inline formatting on one line of raw text. */
export function renderInline(raw: string): string {
  // Code spans first, kept out of the other rules.
  const codes: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${escape(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  text = escape(text);
  // Links: [label](url), only to the web or mail.
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    const href = url.replace(/&amp;/g, '&');
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return whole;
    return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  text = text
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)([^_]*?\S)__/g, '<strong>$1</strong>')
    .replace(/~~(?=\S)([^~]*?\S)~~/g, '<del>$1</del>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

/** A note's markdown as HTML (safe to insert). */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flush = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(3, heading[1].length);
      out.push(`<h${level}>${renderInline(heading[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      const content = (bullet ?? numbered)![1];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
      list.items.push(task ? `<span class="task">${task[1] === ' ' ? '☐' : '☑'}</span> ${renderInline(task[2])}` : renderInline(content));
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line);
  }
  flush();
  return out.join('');
}

const EMOJI_PART = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|⃣|[#*0-9])+$/u;
const PICTURE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The text is nothing but emoji (one or a few, spaces allowed): shown large, and on the minimap. */
export function isEmojiOnly(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return compact.length > 0 && compact.length <= 32 && EMOJI_PART.test(compact) && PICTURE.test(compact);
}
