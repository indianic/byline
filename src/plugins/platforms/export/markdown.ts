/**
 * `htmlToMarkdown` — pure, no I/O. Converts the HTML this codebase's own
 * writing brief produces (see `docs/ADDING-A-PLATFORM.md` and
 * `src/craft/brief.ts`'s `htmlRules`) into Markdown for `article.md`, one of
 * the four files an export platform's hand-off folder always contains.
 *
 * Deliberately hand-rolled rather than pulling in an HTML parser or a
 * Markdown-conversion library: the input is controlled (single-line tags, no
 * script/style, the tag vocabulary `htmlRules` teaches) and this project's
 * dependency list stays at zero runtime deps outside `@modelcontextprotocol`,
 * `yaml`, `zod`, `picocolors`, and `@clack/prompts`.
 */

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Record<string, string>;
  children: MdNode[];
}
interface TextNode {
  type: 'text';
  value: string;
}
type MdNode = ElementNode | TextNode;

/** Tags with no closing tag in well-formed HTML. */
const VOID_TAGS = new Set(['img', 'hr', 'br', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

/** Tags this converter renders as their own block (paragraph-separated) unit. */
const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'p', 'ul', 'ol', 'blockquote', 'figure', 'pre', 'hr', 'table']);

/** Tags rendered inline, inside whatever paragraph-level run they sit in. */
const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'a', 'code', 'img', 'br']);

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&hellip;/gi, '…')
    .replace(/&rsquo;/gi, '’')
    .replace(/&lsquo;/gi, '‘')
    .replace(/&rdquo;/gi, '”')
    .replace(/&ldquo;/gi, '“');
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    attrs[m[1]!.toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] ?? '');
  }
  return attrs;
}

/**
 * Tokenises `html` into a lightweight element tree.
 *
 * Not a general HTML parser — it assumes reasonably well-formed input (the
 * shape `htmlRules` teaches) and defends only against the common malformed
 * cases (an unmatched closing tag, a void element with no self-closing
 * slash) rather than every possibility a browser's parser handles.
 */
function parseHtml(html: string): MdNode[] {
  const tokenRe = /<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?\/?>|[^<]+/g;
  const root: ElementNode = { type: 'element', tag: '#root', attrs: {}, children: [] };
  const stack: ElementNode[] = [root];
  let m: RegExpExecArray | null;

  while ((m = tokenRe.exec(html))) {
    const token = m[0];
    if (token.startsWith('<!--')) continue;

    if (token.startsWith('</')) {
      const name = /^<\/([a-zA-Z][a-zA-Z0-9]*)/.exec(token)?.[1]?.toLowerCase();
      if (!name) continue;
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]!.tag === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (token.startsWith('<')) {
      const name = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(token)?.[1]?.toLowerCase();
      if (!name) continue;
      const node: ElementNode = { type: 'element', tag: name, attrs: parseAttrs(token), children: [] };
      stack[stack.length - 1]!.children.push(node);
      const selfClosing = /\/>\s*$/.test(token) || VOID_TAGS.has(name);
      if (!selfClosing) stack.push(node);
      continue;
    }

    stack[stack.length - 1]!.children.push({ type: 'text', value: token });
  }

  return root.children;
}

function textOf(nodes: MdNode[]): string {
  return nodes
    .map((n) => (n.type === 'text' ? decodeEntities(n.value) : textOf(n.children)))
    .join('');
}

function collapseWhitespace(s: string): string {
  return s.replace(/[ \t\n\r]+/g, ' ').trim();
}

function renderInlineNode(node: MdNode): string {
  if (node.type === 'text') return decodeEntities(node.value);
  switch (node.tag) {
    case 'strong':
    case 'b':
      return `**${renderInline(node.children)}**`;
    case 'em':
    case 'i':
      return `_${renderInline(node.children)}_`;
    case 'a':
      return `[${renderInline(node.children)}](${node.attrs.href ?? ''})`;
    case 'code':
      return `\`${textOf(node.children)}\``;
    case 'img':
      return `![${node.attrs.alt ?? ''}](${node.attrs.src ?? ''})`;
    case 'br':
      return '  \n';
    default:
      // Unknown inline-ish tag — unwrapped: its text survives, its tag does not.
      return renderInline(node.children);
  }
}

function renderInline(nodes: MdNode[]): string {
  return collapseWhitespace(nodes.map(renderInlineNode).join(''));
}

function renderFigure(node: ElementNode): string {
  const img = node.children.find((c) => c.type === 'element' && c.tag === 'img') as ElementNode | undefined;
  const caption = node.children.find((c) => c.type === 'element' && c.tag === 'figcaption') as
    | ElementNode
    | undefined;
  const imgMd = img ? renderInlineNode(img) : '';
  const capMd = caption ? `_${renderInline(caption.children)}_` : '';
  return [imgMd, capMd].filter(Boolean).join('\n');
}

function renderPre(node: ElementNode): string {
  const code = node.children.find((c) => c.type === 'element' && c.tag === 'code') as ElementNode | undefined;
  const text = code ? textOf(code.children) : textOf(node.children);
  return '```\n' + text + '\n```';
}

/** Collects every `<tr>` inside a table, however many `<thead>`/`<tbody>` levels it sits under. */
function collectRows(node: ElementNode, out: ElementNode[]): void {
  for (const c of node.children) {
    if (c.type !== 'element') continue;
    if (c.tag === 'tr') out.push(c);
    else if (c.tag === 'thead' || c.tag === 'tbody' || c.tag === 'tfoot') collectRows(c, out);
  }
}

function renderTable(node: ElementNode): string {
  const rows: ElementNode[] = [];
  collectRows(node, rows);
  if (rows.length === 0) return '';

  const cellsOf = (tr: ElementNode): ElementNode[] =>
    tr.children.filter((c) => c.type === 'element' && (c.tag === 'th' || c.tag === 'td')) as ElementNode[];
  const cellText = (c: ElementNode): string => renderInline(c.children).replace(/\|/g, '\\|');

  const header = cellsOf(rows[0]!);
  const headerLine = `| ${header.map(cellText).join(' | ')} |`;
  const sepLine = `| ${header.map(() => '---').join(' | ')} |`;
  const bodyLines = rows.slice(1).map((tr) => `| ${cellsOf(tr).map(cellText).join(' | ')} |`);

  return [headerLine, sepLine, ...bodyLines].join('\n');
}

/** Renders one `<li>` and any lists nested inside it, indented under its parent marker. */
function renderListItem(li: ElementNode, marker: string, indent: string): string[] {
  const nested = li.children.filter(
    (c) => c.type === 'element' && (c.tag === 'ul' || c.tag === 'ol'),
  ) as ElementNode[];
  const rest = li.children.filter((c) => !(c.type === 'element' && (c.tag === 'ul' || c.tag === 'ol')));

  const body = renderBlock(rest);
  const bodyLines = body.split('\n');
  const lines = [`${indent}${marker} ${bodyLines[0] ?? ''}`];
  for (const extra of bodyLines.slice(1)) {
    lines.push(extra ? `${indent}  ${extra}` : '');
  }
  for (const list of nested) {
    lines.push(...renderList(list, list.tag === 'ol', indent + '  '));
  }
  return lines;
}

function renderList(node: ElementNode, ordered: boolean, indent: string): string[] {
  const lines: string[] = [];
  let n = 0;
  for (const child of node.children) {
    if (!(child.type === 'element' && child.tag === 'li')) continue;
    n++;
    lines.push(...renderListItem(child, ordered ? `${n}.` : '-', indent));
  }
  return lines;
}

const BLOCK_RENDERERS: Record<string, (node: ElementNode) => string> = {
  h1: (n) => `# ${renderInline(n.children)}`,
  h2: (n) => `## ${renderInline(n.children)}`,
  h3: (n) => `### ${renderInline(n.children)}`,
  h4: (n) => `#### ${renderInline(n.children)}`,
  p: (n) => renderInline(n.children),
  hr: () => '---',
  blockquote: (n) => {
    const inner = renderBlock(n.children);
    return inner
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
  },
  ul: (n) => renderList(n, false, '').join('\n'),
  ol: (n) => renderList(n, true, '').join('\n'),
  figure: (n) => renderFigure(n),
  pre: (n) => renderPre(n),
  table: (n) => renderTable(n),
};

/**
 * Renders a sequence of nodes as block-level Markdown, joined by blank lines.
 *
 * A tag not in `BLOCK_TAGS` or `INLINE_TAGS` — `div`, `section`, `span`, and
 * anything else this converter has no opinion about — is unwrapped: its
 * children are spliced into this same block context rather than dropped,
 * mirroring the "unwrapped" behaviour `HtmlProfile.unwrapped` already
 * describes for platform ingest.
 */
function renderBlock(nodes: MdNode[]): string {
  const blocks: string[] = [];
  let run: MdNode[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    const text = renderInline(run);
    if (text) blocks.push(text);
    run = [];
  };

  const walk = (list: MdNode[]): void => {
    for (const node of list) {
      if (node.type === 'text') {
        if (node.value.trim() === '') continue;
        run.push(node);
        continue;
      }
      if (BLOCK_TAGS.has(node.tag)) {
        flush();
        const rendered = BLOCK_RENDERERS[node.tag]!(node);
        if (rendered.trim()) blocks.push(rendered);
        continue;
      }
      if (INLINE_TAGS.has(node.tag)) {
        run.push(node);
        continue;
      }
      // Unknown tag: unwrap by splicing its children into this same context.
      walk(node.children);
    }
  };

  walk(nodes);
  flush();
  return blocks.join('\n\n');
}

export function htmlToMarkdown(html: string): string {
  return renderBlock(parseHtml(html));
}
