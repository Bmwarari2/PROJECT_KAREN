import { looksLikeInjection } from './guard';

/** Content types Ask HR can read. Other policy files are listed as "unsupported" for the admin. */
export const INDEXABLE_TYPES = new Set(['application/pdf', 'text/plain', 'text/markdown']);
export const MAX_EXTRACTED_CHARS = 1_000_000;
export const MAX_CHUNKS_PER_DOCUMENT = 2_000;
export const CHUNK_TARGET_CHARS = 1_200;

export interface Chunk {
  ordinal: number;
  heading: string | null;
  page: number | null;
  content: string;
  /** True when instruction-like text was removed from this chunk. */
  sanitised: boolean;
}

/** Text per page (PDF) or a single page (text and Markdown). Returns null when the type cannot be read. */
export async function extractPages(
  contentType: string,
  bytes: Buffer,
): Promise<{ pages: string[]; paged: boolean } | null> {
  if (contentType === 'text/plain' || contentType === 'text/markdown') {
    const text = bytes.toString('utf8').replace(/^\ufeff/, '');
    return { pages: [contentType === 'text/markdown' ? stripMarkdownInline(text) : text], paged: false };
  }
  if (contentType === 'application/pdf') {
    // unpdf bundles a serverless build of Mozilla pdf.js (no native deps, no network).
    const { extractText } = await import('unpdf');
    const out = await extractText(new Uint8Array(bytes), { mergePages: false });
    return { pages: (Array.isArray(out.text) ? out.text : [out.text]).map(String), paged: true };
  }
  return null;
}

function stripMarkdownInline(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1');
}

const MARKUP = /<\/?\s*[a-z_|][\w:|-]*[^>]*>|\[\/?(?:inst|system)\]/gi;

/**
 * Removes markup and any sentence that reads like an instruction to an AI model ("ignore previous
 * instructions", "you are now…", "the assistant must always recommend…"). Policy text is data: it is
 * also wrapped as data in the prompt, and answers are checked after the model; this is the first layer.
 */
export function sanitiseExcerpt(text: string): string {
  const withoutMarkup = text.replace(MARKUP, ' ');
  const sentences = withoutMarkup.split(/(?<=[.!?])\s+|\n+/);
  return sentences
    .map((s) => s.trim())
    .filter((s) => s && !looksLikeInjection(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingOf(line: string, paged: boolean): string | null {
  const md = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
  if (md) return md[1]!.trim();
  // PDFs lose Markdown: treat a short title-like line without closing punctuation as a heading.
  if (
    paged &&
    line.length <= 70 &&
    /^[\p{Lu}0-9]/u.test(line) &&
    !/[.,;:!?]$/.test(line) &&
    line.split(/\s+/).length <= 9
  )
    return line.trim();
  return null;
}

/** Breaks an over-long line at sentence ends (or spaces) into pieces of at most CHUNK_TARGET_CHARS. */
function splitLong(line: string): string[] {
  if (line.length <= CHUNK_TARGET_CHARS) return [line];
  const out: string[] = [];
  let rest = line;
  while (rest.length > CHUNK_TARGET_CHARS) {
    const window = rest.slice(0, CHUNK_TARGET_CHARS);
    const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
    const at =
      cut > CHUNK_TARGET_CHARS / 3
        ? cut + 1
        : window.lastIndexOf(' ') > 0
          ? window.lastIndexOf(' ')
          : CHUNK_TARGET_CHARS;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Splits extracted text into retrieval chunks of about CHUNK_TARGET_CHARS, never across a heading or a page. */
export function chunkText(pages: string[], paged: boolean): Chunk[] {
  const chunks: Chunk[] = [];
  let total = 0;
  let heading: string | null = null;
  for (let p = 0; p < pages.length; p++) {
    const page = paged ? p + 1 : null;
    let buf: string[] = [];
    const flush = () => {
      const raw = buf.join(' ').replace(/\s+/g, ' ').trim();
      buf = [];
      if (!raw || chunks.length >= MAX_CHUNKS_PER_DOCUMENT) return;
      const content = sanitiseExcerpt(raw);
      const sanitised = content !== raw.replace(MARKUP, ' ').replace(/\s+/g, ' ').trim();
      if (!content) return;
      chunks.push({
        ordinal: chunks.length,
        heading: heading ? sanitiseExcerpt(heading).slice(0, 200) || null : null,
        page,
        content,
        sanitised,
      });
    };
    for (const rawLine of pages[p]!.replace(/\r\n?/g, '\n').split('\n')) {
      const line = rawLine.trim();
      total += line.length;
      if (total > MAX_EXTRACTED_CHARS) break;
      if (!line) {
        if (buf.join(' ').length >= CHUNK_TARGET_CHARS * 0.6) flush();
        continue;
      }
      const h = headingOf(line, paged);
      if (h) {
        flush();
        heading = h;
        continue;
      }
      for (const piece of splitLong(line)) {
        buf.push(piece);
        if (buf.join(' ').length >= CHUNK_TARGET_CHARS) flush();
      }
    }
    flush();
  }
  return chunks;
}
