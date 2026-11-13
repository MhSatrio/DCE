/**
 * Write → check → (rewrite) loop. The model calls are injected, so the loop is tested with fakes and no network.
 * Up to 3 drafts: after each rejected draft the writer receives the exact reasons and tries again.
 * Fail closed: when the reviewer model cannot answer with a usable verdict, the post is not accepted.
 */
import type { GuardReport } from '../db/schema';
import { StoppedError } from './abort';
import { GeminiError } from './gemini';
import { assemblePost, checkRules, failedRules, parseJsonLoose, toDraft, verifierPrompt, writerPrompt, type Draft, type GuardOptions } from './guard';

export interface ComposeDeps {
  /** Calls the writer model; returns raw text (JSON). */
  write: (p: { system: string; user: string }) => Promise<string>;
  /** Calls the reviewer model; returns raw text (JSON). */
  verify: (p: { system: string; user: string }) => Promise<string>;
}
export interface ComposeSource { title: string; url: string; summary: string; text: string }
export type ComposeResult =
  | { ok: true; draft: Draft; text: string; guard: GuardReport }
  | { ok: false; reason: string; guard: GuardReport };

export const MAX_DRAFTS = 3;

export async function composePost(src: ComposeSource, opts: GuardOptions & { voice: string; instructions?: string }, deps: ComposeDeps, onStep?: (s: string) => void): Promise<ComposeResult> {
  const evidence = [src.title, src.summary, src.text].join('\n');
  let feedback: string[] = [];
  let guard: GuardReport = { rules: [], attempts: 0 };
  for (let attempt = 1; attempt <= MAX_DRAFTS; attempt++) {
    onStep?.(`Draft ${attempt}: asking the writer model…`);
    const raw = await deps.write(writerPrompt(src, { voice: opts.voice, maxChars: opts.maxChars, feedback, instructions: opts.instructions }));
    const draft = toDraft(parseJsonLoose(raw));
    if (!draft) { feedback = ['Reply with valid JSON only: {"hook": string, "lines": string[], "cta": string, "hashtags": string[]}.']; guard = { rules: [{ rule: 'format', ok: false, message: 'The model did not return the expected JSON.' }], attempts: attempt }; continue; }

    const rules = checkRules(draft, { url: src.url, text: evidence }, opts);
    const bad = failedRules(rules);
    guard = { rules, attempts: attempt };
    if (bad.length) { feedback = bad.map((b) => b.message); onStep?.(`Draft ${attempt} failed the rules: ${feedback.join(' ')}`); continue; }

    const { text } = assemblePost(draft, src.url);
    onStep?.(`Draft ${attempt} passed the rules — asking the reviewer model to fact-check it…`);
    let verdict: { ok?: unknown; issues?: unknown } | null = null;
    try {
      verdict = parseJsonLoose<{ ok?: unknown; issues?: unknown }>(await deps.verify(verifierPrompt({ title: src.title, text: evidence }, text)));
    } catch (e) {
      if (e instanceof StoppedError) throw e; // Stop pressed: never treated as "the reviewer could not check"
      if (e instanceof GeminiError && e.retryable) throw e; // quota / outage: the run fails and is retried, nothing is published unchecked
      guard.verifier = { ok: false, issues: [], skipped: e instanceof Error ? e.message : String(e) };
      feedback = ['The reviewer could not check the post.'];
      continue;
    }
    const issues = Array.isArray(verdict?.issues) ? verdict!.issues.map(String).filter(Boolean) : [];
    if (!verdict || typeof verdict.ok !== 'boolean') { guard.verifier = { ok: false, issues: [], skipped: 'The reviewer returned no usable verdict (fail closed).' }; feedback = ['The reviewer could not check the post.']; continue; }
    guard.verifier = { ok: verdict.ok, issues };
    if (verdict.ok) return { ok: true, draft, text, guard };
    feedback = issues.length ? issues : ['The reviewer found an unsupported statement.'];
    onStep?.(`Draft ${attempt} was rejected by the reviewer: ${feedback.join(' ')}`);
  }
  const why = guard.verifier && !guard.verifier.ok ? `The reviewer rejected every draft: ${(guard.verifier.issues.join(' ') || guard.verifier.skipped) ?? ''}` : `Every draft broke a rule: ${failedRules(guard.rules).map((r) => r.message).join(' ') || guard.rules.map((r) => r.message).join(' ')}`;
  return { ok: false, reason: why.trim(), guard };
}
