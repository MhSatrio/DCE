/** Markdown → sanitised HTML. Both libraries are loaded on demand (not in the first bundle). */
let libs: Promise<{ parse: (s: string) => string; clean: (h: string) => string }> | null = null;

async function load() {
  if (!libs) {
    libs = Promise.all([import('marked'), import('dompurify')]).then(([m, d]) => {
      const purify = d.default;
      return {
        parse: (s: string) => m.marked.parse(s, { async: false, gfm: true, breaks: true }) as string,
        clean: (h: string) => purify.sanitize(h, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style', 'onerror', 'onclick'] }),
      };
    });
  }
  return libs;
}

export async function renderMarkdown(src: string): Promise<string> {
  const { parse, clean } = await load();
  return clean(parse(src));
}
