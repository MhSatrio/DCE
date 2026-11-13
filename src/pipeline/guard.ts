/**
 * Post assembly and guardrails (pure functions).
 *
 * Two layers, because each catches what the other cannot:
 *  1. RULES (this file, deterministic, free, instant) — structure, length, exactly one link and it is the source URL,
 *     no medical claims / outcome promises (phrase list), and every number or price in the post must occur in the source.
 *  2. A SECOND, SEPARATE model call (run.ts + `verifierPrompt`) that reads the source and the finished post and answers:
 *     is every statement supported by the source, and is there any medical claim or promise? It cannot be fooled by the
 *     writer's phrasing because it never sees the writer's reasoning, only the result. If it cannot answer, the post is
 *     NOT published (fail closed).
 * The link is appended by code, never typed by the model, so the URL in a post cannot be wrong or invented.
 */
import { normUrl } from './extract';

export interface Draft { hook: string; lines: string[]; cta: string; hashtags: string[] }
export interface RuleResult { rule: string; ok: boolean; message: string }
export interface GuardOptions { maxChars: number; bannedPhrases: string[] }

export const DEFAULT_MAX_CHARS = 500;

/** Outcome promises, cure / treatment claims and absolute safety claims. One phrase per line in Settings; matched as whole words. */
export const DEFAULT_BANNED = [
  'cure', 'cures', 'cured', 'curing', 'heal', 'heals', 'healed', 'guarantee', 'guarantees', 'guaranteed', 'promise', 'promises', 'promised',
  '100%', 'risk-free', 'risk free', 'no risk', 'no side effects', 'painless', 'miracle', 'permanent results', 'proven to', 'clinically proven',
  'safe for everyone', 'will fix', 'FDA approved', 'FDA-approved', 'best results', 'instant results', 'life-changing results', 'eliminates', 'reverses',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanHashtags(list: string[]): string[] {
  const out: string[] = [];
  for (const h of list) {
    const t = '#' + String(h).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (t.length > 1 && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** hook, lines, CTA, link, hashtags — the link comes from the source, never from the model. */
export function assemblePost(d: Draft, url: string): { text: string; beforeLink: string } {
  const beforeLink = [d.hook.trim(), d.lines.map((l) => l.trim()).filter(Boolean).join('\n'), d.cta.trim()].filter(Boolean).join('\n\n');
  const text = `${beforeLink}\n${url}\n\n${cleanHashtags(d.hashtags).join(' ')}`.trim();
  return { text, beforeLink };
}

/** Numbers that carry meaning: prices, percentages, decimals, and integers of two or more digits (years, counts). */
export function numbersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:[$€£¥]|Rp\.?|USD|EUR|IDR|GBP)?\s?\d[\d.,]*\s?(?:%|k\b|m\b|million|billion|USD|EUR|IDR)?/gi)) {
    const raw = m[0];
    const hasUnit = /[$€£¥%]|Rp|USD|EUR|IDR|GBP|k$|m$|million|billion/i.test(raw);
    // thousands separators (1,200 / 1.500.000) are dropped, a decimal comma becomes a point — identically on both sides of the comparison
    const digits = raw.replace(/[^\d.,]/g, '').replace(/[.,]+$/, '').replace(/[.,](?=\d{3}(?!\d))/g, '').replace(',', '.');
    if (!digits) continue;
    if (/^\d$/.test(digits) && !hasUnit) continue; // "3 tips", "step 2" — single digits are not claims
    out.add(digits);
  }
  return [...out];
}

export function checkRules(draft: Draft, source: { url: string; text: string }, opts: GuardOptions): RuleResult[] {
  const res: RuleResult[] = [];
  const add = (rule: string, ok: boolean, message: string) => res.push({ rule, ok, message });
  const { text, beforeLink } = assemblePost(draft, source.url);
  const tags = cleanHashtags(draft.hashtags);
  const lines = draft.lines.map((l) => l.trim()).filter(Boolean);

  add('structure', !!draft.hook.trim() && lines.length >= 2 && lines.length <= 4 && !!draft.cta.trim(),
    !draft.hook.trim() ? 'The hook is empty.' : lines.length < 2 || lines.length > 4 ? `Expected 2–4 value lines, got ${lines.length}.` : !draft.cta.trim() ? 'The call to action is empty.' : 'Hook, 2–4 lines and a call to action are present.');
  add('length', beforeLink.length <= opts.maxChars, `${beforeLink.length} characters before the link (limit ${opts.maxChars}).`);
  add('hashtags', tags.length >= 3 && tags.length <= 5, `${tags.length} hashtags (needs 3–5).`);

  const urls = text.match(/https?:\/\/[^\s]+/gi) ?? [];
  const only = urls.length === 1 && normUrl(urls[0]) === normUrl(source.url);
  add('link', only && (!/(^|\s)www\.[a-z0-9-]+\./i.test(beforeLink)), only ? 'Exactly one link: the source page.' : 'The post must contain only the source link (no other URLs).');

  const banned = opts.bannedPhrases.map((p) => p.trim()).filter(Boolean);
  const hits = banned.filter((p) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(p)}(?![\\p{L}\\p{N}])`, 'iu').test(beforeLink));
  add('claims', hits.length === 0, hits.length ? `Medical claim / outcome promise wording: “${hits.join('”, “')}”.` : 'No medical-claim or outcome-promise wording.');

  const have = new Set(numbersIn(source.text));
  const stray = numbersIn(beforeLink).filter((n) => !have.has(n));
  add('numbers', stray.length === 0, stray.length ? `Number(s) not found in the source page: ${stray.join(', ')} — possibly invented.` : 'Every number or price also appears in the source.');
  return res;
}

export const failedRules = (r: RuleResult[]) => r.filter((x) => !x.ok);

// ------------------------------------------------------------------------------------------------ prompts

export const DEFAULT_VOICE = 'Clear, calm, factual and friendly. Plain English. No hype, no emojis unless one genuinely helps.';

/**
 * Always added to the writer, whatever the writing instructions say: the answer format and the rules that keep the post
 * honest. The instructions you edit are only the part about what to write and how it sounds.
 */
export const FIXED_RULES = [
  'You write ONE social media post that promotes a single web page. You use ONLY facts stated in the SOURCE below.',
  'These rules always apply, whatever the writing instructions say:',
  '- Never invent facts, names, prices, numbers, dates, statistics, results or testimonials. If the source does not say it, do not write it.',
  '- Never make medical claims, never promise or imply outcomes (no “cure”, “guaranteed”, “best results”, “risk-free”, …).',
  '- Do NOT write any URL — the link is added automatically.',
  'Reply with JSON only, exactly: {"hook": string, "lines": string[], "cta": string, "hashtags": string[]}',
];

/** The writing instructions used when the pipeline has none of its own. */
export const DEFAULT_INSTRUCTIONS = [
  'Write the post in four parts:',
  '- "hook": one short attention-grabbing line.',
  '- "lines": 2 to 4 short lines (each under 140 characters) giving real value taken from the source.',
  '- "cta": one short call to action that invites the reader to open the page.',
  '- "hashtags": 3 to 5 relevant hashtags, no spaces inside a hashtag.',
  'Brand voice: {{voice}}',
].join('\n');

/** Fills {{name}} placeholders; an unknown placeholder is left as it is. */
export function renderInstructions(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

export function writerPrompt(src: { title: string; url: string; summary: string; text: string }, opts: { voice: string; maxChars: number; feedback?: string[]; instructions?: string }): { system: string; user: string } {
  const template = (opts.instructions ?? '').trim() ? opts.instructions! : DEFAULT_INSTRUCTIONS;
  let instructions = renderInstructions(template, {
    title: src.title, url: src.url, summary: src.summary, text: src.text.slice(0, 6000), voice: opts.voice, max_chars: String(opts.maxChars),
  });
  // the brand voice is added as a note unless the instructions already place it with {{voice}}
  if (!template.includes('{{voice}}') && opts.voice.trim()) instructions += `\nBrand voice: ${opts.voice}`;
  const system = [...FIXED_RULES, `- Hook + lines + cta together must be under ${opts.maxChars - 40} characters.`].join('\n');
  const user = [
    'WRITING INSTRUCTIONS:',
    instructions,
    '',
    'SOURCE (the only allowed facts):',
    `Title: ${src.title}`,
    `Page: ${src.url}`,
    src.summary ? `Description: ${src.summary}` : '',
    'Text:',
    src.text.slice(0, 6000),
    ...(opts.feedback?.length ? ['', 'Your previous draft was rejected for these reasons — fix all of them:', ...opts.feedback.map((f) => `- ${f}`)] : []),
  ].filter((x) => x !== '').join('\n');
  return { system, user };
}

export function verifierPrompt(src: { title: string; text: string }, post: string): { system: string; user: string } {
  const system = [
    'You are a strict fact-checker and compliance reviewer for social media posts.',
    'You get a SOURCE page text and a finished POST. Decide whether the POST is acceptable.',
    'Acceptable only if ALL are true:',
    '1. Every factual statement in the POST is directly supported by the SOURCE (no invented facts, prices, numbers, names or results).',
    '2. The POST makes no medical claim and promises no outcome (no cure, guarantee, “best results”, risk-free, etc.).',
    '3. The POST does not imply anything the SOURCE does not say.',
    'Reply with JSON only, exactly: {"ok": boolean, "issues": string[]}. “issues” lists each problem briefly; empty when ok.',
  ].join('\n');
  const user = `SOURCE TITLE: ${src.title}\nSOURCE TEXT:\n${src.text.slice(0, 6000)}\n\nPOST:\n${post}`;
  return { system, user };
}

/** Tolerant JSON extraction: models sometimes wrap the object in ``` fences or add a sentence. */
export function parseJsonLoose<T>(text: string): T | null {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) as T; } catch { /* give up */ } }
  return null;
}

export function toDraft(v: unknown): Draft | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(str).filter(Boolean) : typeof x === 'string' ? x.split(/\n+/).map((s) => s.trim()).filter(Boolean) : []);
  const d: Draft = { hook: str(o.hook), lines: arr(o.lines), cta: str(o.cta), hashtags: arr(o.hashtags) };
  return d.hook || d.lines.length ? d : null;
}

/** Re-checks a post whose text a human edited (the structure of hook / lines is no longer known). */
export function checkEdited(text: string, source: { url: string; text: string }, opts: GuardOptions): RuleResult[] {
  const res: RuleResult[] = [];
  const add = (rule: string, ok: boolean, message: string) => res.push({ rule, ok, message });
  const i = text.indexOf(source.url);
  const beforeLink = (i >= 0 ? text.slice(0, i) : text).trim();
  add('length', beforeLink.length <= opts.maxChars, `${beforeLink.length} characters before the link (limit ${opts.maxChars}).`);
  const urls = text.match(/https?:\/\/[^\s]+/gi) ?? [];
  const only = urls.length === 1 && normUrl(urls[0]) === normUrl(source.url);
  add('link', only, only ? 'Exactly one link: the source page.' : 'The post must contain exactly one link: the source page.');
  const tags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  add('hashtags', tags.length >= 3 && tags.length <= 5, `${tags.length} hashtags (needs 3–5).`);
  const banned = opts.bannedPhrases.map((p) => p.trim()).filter(Boolean);
  const hits = banned.filter((p) => new RegExp(`(?<![\p{L}\p{N}])${escapeRe(p)}(?![\p{L}\p{N}])`, 'iu').test(beforeLink));
  add('claims', hits.length === 0, hits.length ? `Medical claim / outcome promise wording: “${hits.join('”, “')}”.` : 'No medical-claim or outcome-promise wording.');
  const have = new Set(numbersIn(source.text));
  const stray = numbersIn(beforeLink).filter((n) => !have.has(n));
  add('numbers', stray.length === 0, stray.length ? `Number(s) not found in the source page: ${stray.join(', ')}.` : 'Every number or price also appears in the source.');
  return res;
}
