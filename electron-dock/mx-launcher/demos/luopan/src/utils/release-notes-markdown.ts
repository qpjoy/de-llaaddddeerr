const MAX_MARKDOWN_LENGTH = 20_000;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderInlineMarkdown(value: unknown): string {
  const tokens: string[] = [];
  const stash = (html: string): string => {
    const index = tokens.push(html) - 1;
    return `\u0000${index}\u0000`;
  };
  let source = String(value ?? '').replaceAll('\u0000', '');
  source = source.replace(/`([^`\n]+)`/g, (_match, code: string) => stash(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_match, label: string, href: string) => {
    try {
      const url = new URL(href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return label;
      return stash(
        `<a href="${escapeHtml(url.toString())}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`
      );
    } catch {
      return label;
    }
  });
  source = escapeHtml(source)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  return source.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || '');
}

export function renderReleaseNotesMarkdown(value: unknown): string {
  const source = String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_MARKDOWN_LENGTH);
  if (!source) return '';
  const output: string[] = [];
  const paragraph: string[] = [];
  let listType: 'ul' | 'ol' | '' = '';
  let quoteLines: string[] = [];
  let fence: { language: string } | null = null;
  let fenceLines: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph.length = 0;
  };
  const closeList = (): void => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = '';
  };
  const flushQuote = (): void => {
    if (quoteLines.length === 0) return;
    output.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br>')}</blockquote>`);
    quoteLines = [];
  };
  const flushOpenBlocks = (): void => {
    flushParagraph();
    closeList();
    flushQuote();
  };

  for (const line of source.split('\n')) {
    const fenceMatch = line.match(/^\s*```([\w+-]*)\s*$/);
    if (fence) {
      if (fenceMatch) {
        const language = fence.language ? ` class="language-${escapeHtml(fence.language)}"` : '';
        output.push(`<pre><code${language}>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
        fence = null;
        fenceLines = [];
      } else {
        fenceLines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      flushOpenBlocks();
      fence = { language: fenceMatch[1] || '' };
      continue;
    }
    if (!line.trim()) {
      flushOpenBlocks();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushOpenBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushOpenBlocks();
      output.push('<hr>');
      continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      quoteLines.push(quote[1]);
      continue;
    }
    flushQuote();
    const unordered = line.match(/^\s{0,3}[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s{0,3}\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextType = ordered ? 'ol' : 'ul';
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInlineMarkdown((unordered || ordered)?.[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  if (fence) {
    const language = fence.language ? ` class="language-${escapeHtml(fence.language)}"` : '';
    output.push(`<pre><code${language}>${escapeHtml(fenceLines.join('\n'))}</code></pre>`);
  } else {
    flushOpenBlocks();
  }
  return output.join('');
}
