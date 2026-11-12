import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";

/**
 * Render agent-written Markdown to HTML for the read-only website.
 *
 * Content comes from agents, so it is treated as untrusted:
 * - raw HTML in the Markdown is shown as text, never passed through;
 * - links keep only http(s), mailto and same-site targets;
 * - images load only over https, or from the brain itself via "image:<id>";
 * - everything else is escaped by marked or highlight.js.
 * GitHub-flavoured Markdown (tables, task lists, strikethrough, autolinks) is on.
 */

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Return a safe href, or null when the target uses a scheme we do not allow. */
export function safeHref(href: string, opts: { images?: boolean } = {}): string | null {
  // Browsers ignore control characters and whitespace inside schemes ("java\tscript:"), so strip them first.
  // eslint-disable-next-line no-control-regex
  const cleaned = href.replace(/[\u0000-\u001f\u007f\s]+/g, "");
  if (!cleaned) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned)?.[1]?.toLowerCase();
  if (opts.images) return scheme === "https" ? cleaned : null;
  if (scheme === undefined) {
    // Relative links and fragments. Protocol-relative "//host" links leave the site, so require an explicit scheme.
    return cleaned.startsWith("//") || cleaned.startsWith("\\") ? null : cleaned;
  }
  return scheme === "http" || scheme === "https" || scheme === "mailto" ? cleaned : null;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-z0-9#]+;/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}

function highlight(code: string, lang: string | undefined): { html: string; language: string | null } {
  const name = lang?.trim().split(/\s+/)[0]?.toLowerCase();
  if (name && hljs.getLanguage(name)) {
    return { html: hljs.highlight(code, { language: name, ignoreIllegals: true }).value, language: name };
  }
  return { html: escapeHtml(code), language: name || null };
}

/** Matches an in-brain image reference, ![alt](image:<id>). */
const IMAGE_REF = /^image:([0-9a-z]{16})$/i;

export interface RenderOptions {
  /** Site path of the brain's images, for example /brains/<project>/<brain>/images. Enables image:<id> references. */
  imageBase?: string;
}

function createRenderer(opts: RenderOptions): Marked {
  const headingIds = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      code({ text, lang }: Tokens.Code) {
        const { html, language } = highlight(text, lang);
        const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
        const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ` class="hljs"`;
        return `<div class="code${language ? " labelled" : ""}">${label}<pre><code${cls}>${html}</code></pre></div>\n`;
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        let id = slug(inner) || "section";
        const seen = headingIds.get(id) ?? 0;
        headingIds.set(id, seen + 1);
        if (seen) id = `${id}-${seen}`;
        return `<h${depth} id="h-${escapeHtml(id)}"><a class="anchor" href="#h-${escapeHtml(id)}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
      },
      table(token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: "th" | "td") => {
          const align = c.align ? ` style="text-align:${c.align}"` : "";
          return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${token.header.map((c) => cell(c, "th")).join("")}</tr>`;
        const body = token.rows.map((row) => `<tr>${row.map((c) => cell(c, "td")).join("")}</tr>`).join("");
        return `<div class="table-wrap"><table><thead>${head}</thead>${body ? `<tbody>${body}</tbody>` : ""}</table></div>\n`;
      },
      checkbox({ checked }: Tokens.Checkbox) {
        return `<input type="checkbox" disabled${checked ? " checked" : ""}> `;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const safe = safeHref(href);
        if (!safe) return inner;
        const external = /^(https?:|mailto:)/i.test(safe);
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        const rel = external ? ` rel="noopener noreferrer nofollow" target="_blank"` : "";
        return `<a href="${escapeHtml(safe)}"${t}${rel}>${inner}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const ref = IMAGE_REF.exec(href.trim());
        if (ref) {
          if (!opts.imageBase) return escapeHtml(text ? `[image: ${text}]` : "[image]");
          const page = `${opts.imageBase}/${ref[1]!.toLowerCase()}`;
          const t = title ? ` title="${escapeHtml(title)}"` : "";
          return `<a class="brain-image" href="${escapeHtml(page)}"><img src="${escapeHtml(`${page}/raw`)}" alt="${escapeHtml(text)}"${t} loading="lazy"></a>`;
        }
        const safe = safeHref(href, { images: true });
        if (!safe) return escapeHtml(text ? `[image: ${text}]` : "[image]");
        const t = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${escapeHtml(safe)}" alt="${escapeHtml(text)}"${t} loading="lazy" referrerpolicy="no-referrer">`;
      },
    },
  });
  return marked;
}

export function renderMarkdown(markdown: string, opts: RenderOptions = {}): string {
  // A fresh instance per call keeps heading IDs unique within one document only.
  return createRenderer(opts).parse(markdown, { async: false }) as string;
}
