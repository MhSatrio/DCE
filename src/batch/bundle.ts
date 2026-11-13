import { zipSync, strToU8 } from 'fflate';
import { recordContent, templateAssetIds } from '../db/repo';
import { db, type ContentRecord, type TemplateRow } from '../db/schema';
import { slugify } from '../engine/binding';
import { cloneDoc, serializeNjs, walkNodes } from '../engine/njs';
import { download } from '../ui/kit';
import { RENDER_PY } from './render_py';

const extOf = (mime: string) => (mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg');

const README = (name: string, n: number) => `# DCE external render bundle

Template: **${name}** · Records: **${n}**

This bundle lets you render the same \`.njs\` design outside the browser, for example on a server or for very large jobs.
The browser renderer in DCE stays the reference implementation; \`render.py\` is a compatible **subset** renderer built on Pillow.

## Contents

| File | Purpose |
|---|---|
| \`template.njs\` | The design (same schema DCE uses, assets referenced by id) |
| \`data.json\` | \`{ "records": [ { "content": {...}, "template": {...} } ] }\` — every record's resolved \`content.*\` scope |
| \`assets/\` | Image files named \`<asset id>.<ext>\` (referenced by \`content.image_asset\` and static image nodes) |
| \`fonts/\` | Put TrueType files here (e.g. \`Jost[wght].ttf\` from Google Fonts). Without them Pillow falls back to DejaVu Sans |
| \`render.py\` | The renderer |

## Setup

\`\`\`bash
python -m venv .venv && . .venv/bin/activate     # Windows: .venv\\Scripts\\activate
pip install -r requirements.txt                    # Pillow >= 10.1
\`\`\`

## Run

\`\`\`bash
python render.py --template template.njs --data data.json --out out --format png --workers 4
python render.py --limit 10 --format jpeg --quality 0.9 --pattern "{{index:4}}-{{content.slug}}"
\`\`\`

\`out/manifest.json\` lists every file and every failure with its error. The exit code is 1 when any record failed.

## Supported / not supported

Supported: rectangles (corner radius), ellipses, lines, polygons, stars, simple paths, text (wrapping, all five overflow policies,
alignment, line height, padding, underline / line-through), image and frame nodes (cover / contain / fill / crop, focal point,
rounded corners, fallback image), groups, rotation, opacity, text/image/fill/visibility bindings, \`{{key|filter}}\` filters,
the safe expression language (no \`eval\`), placeholder defaults and required values, file-name patterns.

Not supported (documented differences): **letter spacing**, embedded web fonts (use TTF/OTF in \`fonts/\`), exact glyph metrics
(line breaks can differ by a pixel or a word in rare cases), SVG / PDF / HTML output (use the browser app), and anything added to the schema later.
Pixel parity with the browser renderer is **not** claimed — compare a sample before committing to a large job.
`;

/** Builds and downloads dce-render-bundle.zip for the template and the chosen records. */
export async function exportBundle(tpl: TemplateRow, records: ContentRecord[]): Promise<number> {
  const doc = cloneDoc(tpl.doc);
  const files: Record<string, Uint8Array> = {};
  const wanted = new Set<string>(templateAssetIds(doc));
  for (const n of walkNodes(doc.nodes)) if (n.binding?.image?.fallback) wanted.add(n.binding.image.fallback);
  const data = records.map((r) => {
    const c = recordContent(r);
    for (const v of Object.values(c)) if (typeof v === 'string' && v.length >= 8 && v.length <= 64) wanted.add(v);
    return { content: c, template: Object.fromEntries(doc.placeholders.filter((p) => p.key.startsWith('template.') && p.default_value !== undefined).map((p) => [p.key.slice(9), p.default_value])) };
  });
  const rows = (await db.assets.bulkGet([...wanted])).filter((a): a is NonNullable<typeof a> => !!a);
  doc.assets = rows.map((a) => ({ id: a.id, name: a.name, mime: a.mime, width: a.width, height: a.height }));
  for (const a of rows) files[`assets/${a.id}.${extOf(a.mime)}`] = new Uint8Array(await a.blob.arrayBuffer());
  files['template.njs'] = strToU8(serializeNjs(doc));
  files['data.json'] = strToU8(JSON.stringify({ generated_by: 'VierApparatus DCE', template_id: doc.meta.id, records: data }, null, 1));
  files['render.py'] = strToU8(RENDER_PY);
  files['requirements.txt'] = strToU8('Pillow>=10.1\n');
  files['README.md'] = strToU8(README(tpl.name, records.length));
  files['fonts/README.txt'] = strToU8('Place Jost (or other) .ttf files here. Pillow cannot read .woff2.\n');
  const rooted: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) rooted[`dce-render-bundle/${k}`] = v;
  const zip = zipSync(rooted, { level: 1 });
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), `dce-render-bundle-${slugify(tpl.name) || 'template'}.zip`);
  return records.length;
}
