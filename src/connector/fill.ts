import { parseJsonLoose } from '../pipeline/guard';

/**
 * The prompt of an "ai_fill" step. Each placeholder {{column|what to write}} names a column of the table and says what Gemini
 * should write into it. The source is the website item (title, excerpt, body, …) and Gemini may use only what it says.
 *   Write a summary: {{summary|two short sentences in plain English}}
 *   Write a hook: {{hook|one line, no emojis}}
 */
export type Placeholder = { key: string; description: string };

/** The placeholder syntax; the key is a column key, the description is optional. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|([^{}]*))?\}\}/g;

/** The distinct placeholders of a prompt, in the order they first appear. */
export function parsePlaceholders(prompt: string): Placeholder[] {
  const out: Placeholder[] = [];
  const seen = new Set<string>();
  for (const m of prompt.matchAll(PLACEHOLDER)) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, description: (m[2] ?? '').trim() });
  }
  return out;
}

/** The text of the website item that Gemini may use: whatever long text the event carries, in a fixed order. */
export function sourceTextOf(payload: Record<string, unknown>): { title: string; url: string; text: string } {
  const title = String(payload.title ?? payload.name ?? '');
  const url = String(payload.url ?? '');
  const parts: string[] = [];
  for (const k of ['excerpt', 'shortDescription', 'description', 'body', 'editorialReview']) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  if (Array.isArray(payload.advantages) && payload.advantages.length) parts.push(`Advantages: ${payload.advantages.map(String).join('; ')}`);
  if (Array.isArray(payload.limitations) && payload.limitations.length) parts.push(`Limitations: ${payload.limitations.map(String).join('; ')}`);
  return { title, url, text: parts.join('\n\n') };
}

/** The system and user messages for one row. The placeholders in the instructions are shown as [column] names. */
export function buildFillPrompt(prompt: string, fields: Placeholder[], source: { title: string; url: string; text: string }): { system: string; user: string } {
  const keys = fields.map((f) => f.key);
  const instructions = prompt.replace(PLACEHOLDER, (_m, key: string) => `[${key}]`);
  const system = [
    'You fill the columns of ONE row of a database from a source article.',
    'Use ONLY facts stated in the SOURCE. Never invent facts, numbers, names, prices or claims. If the source does not say something, do not write it.',
    `Reply with JSON only: an object with exactly these keys: ${keys.join(', ')}. Every value is a plain string.`,
  ].join('\n');
  const user = [
    'INSTRUCTIONS:',
    instructions,
    '',
    'COLUMNS:',
    ...fields.map((f) => `- ${f.key}${f.description ? `: ${f.description}` : ''}`),
    '',
    'SOURCE:',
    `Title: ${source.title}`,
    `Address: ${source.url}`,
    'Text:',
    source.text.slice(0, 12000),
  ].join('\n');
  return { system, user };
}

/** Checks Gemini's answer: every column must be present, non-empty and not too long. Nothing is written unless all pass. */
export function parseFillOutput(raw: string, fields: Placeholder[]): { values: Record<string, string>; problems: string[] } {
  const values: Record<string, string> = {};
  const problems: string[] = [];
  const obj = parseJsonLoose<Record<string, unknown>>(raw);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { values, problems: ['Gemini did not return the expected JSON object.'] };
  for (const f of fields) {
    const v = obj[f.key];
    const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
    if (!s) { problems.push(`“${f.key}” is empty.`); continue; }
    if (s.length > 5000) { problems.push(`“${f.key}” is too long (${s.length} characters, 5000 at most).`); continue; }
    values[f.key] = s;
  }
  return { values, problems };
}
