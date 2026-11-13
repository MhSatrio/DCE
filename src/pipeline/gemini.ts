/**
 * Minimal client for the Gemini API (Google Generative Language API, the free tier works with an AI Studio key).
 * The browser may call it directly: Google answers CORS preflights. The key is sent in the `x-goog-api-key` header
 * (never in the URL, so it cannot end up in logs or history) and is decrypted from the vault only for this call.
 */
import { linked, sleepAbortable, StoppedError } from './abort';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
/** "auto" = the newest Flash text model that the user's key lists (see pickModel). Anything else is used as typed. */
export const AUTO_MODEL = 'auto';
export const DEFAULT_MODEL = AUTO_MODEL;
/** A single Gemini call may take this long before it is treated as a network failure. */
export const GEMINI_TIMEOUT_MS = 120_000;

/**
 * Picks the newest Flash text model from a key's list: highest version first, stable before preview, and never a lite,
 * image, audio, live, embedding, thinking or experimental variant. Falls back to any other text model, else undefined.
 */
export function pickModel(names: string[]): string | undefined {
  const BAD = /(lite|image|tts|live|audio|embed|robotics|computer|native|thinking|exp)/i;
  const flash = names.flatMap((n) => {
    const m = /^gemini-(\d+(?:\.\d+)?)-flash(.*)$/i.exec(n);
    return m && !BAD.test(m[2]) ? [{ n, v: parseFloat(m[1]), preview: /preview/i.test(m[2]) }] : [];
  });
  flash.sort((a, b) => b.v - a.v || Number(a.preview) - Number(b.preview));
  return flash[0]?.n ?? names.find((n) => /^gemini-/i.test(n) && !BAD.test(n));
}

export type GeminiErrorKind = 'auth' | 'quota' | 'server' | 'blocked' | 'network' | 'bad';
export class GeminiError extends Error {
  constructor(public kind: GeminiErrorKind, message: string, public status = 0) { super(message); }
  /** Worth trying again later? Bad keys and blocked content are not. */
  get retryable() { return this.kind === 'quota' || this.kind === 'server' || this.kind === 'network'; }
}

export interface GenerateOptions { base?: string; model?: string; system?: string; temperature?: number; json?: boolean; maxOutputTokens?: number; signal?: AbortSignal }

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export function describeHttp(status: number, msg: string): GeminiError {
  const m = msg.slice(0, 220);
  if (status === 429) return new GeminiError('quota', `Gemini quota or rate limit reached (free tier). ${m}`, status);
  if (status === 401 || status === 403 || /API key (not valid|expired)|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return new GeminiError('auth', `Gemini rejected the API key (invalid, expired or not allowed). ${m}`, status);
  if (status === 400) return new GeminiError('bad', `Gemini rejected the request: ${m}`, status);
  if (status === 404) return new GeminiError('bad', `Gemini model not found — in Content pipeline → Overview → Gemini model, pick Auto or another model. ${m}`, status);
  return new GeminiError('server', `Gemini answered HTTP ${status}. ${m}`, status);
}

/** One HTTP call with a time limit; Stop aborts it at once (StoppedError), a timeout is a retryable network error. */
async function call(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<{ status: number; ok: boolean; text: string }> {
  const req = linked(signal, GEMINI_TIMEOUT_MS);
  try {
    let res: Response;
    try { res = await fetch(url, { ...init, signal: req.signal }); }
    catch {
      if (signal?.aborted) throw new StoppedError();
      throw new GeminiError('network', req.timedOut() ? 'Gemini did not answer within 2 minutes.' : 'Could not reach the Gemini API (offline, or blocked by a firewall).');
    }
    try {
      return { status: res.status, ok: res.ok, text: await res.text() };
    } catch {
      if (signal?.aborted) throw new StoppedError();
      throw new GeminiError('network', 'The connection to Gemini broke while it was answering.');
    }
  } finally { req.done(); }
}

export async function generate(apiKey: string, prompt: string, o: GenerateOptions = {}): Promise<string> {
  const base = (o.base || GEMINI_BASE).replace(/\/+$/, '');
  const model = (o.model || DEFAULT_MODEL).replace(/^models\//, '');
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: o.temperature ?? 0.6, maxOutputTokens: o.maxOutputTokens ?? 4096, ...(o.json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (o.system) body.systemInstruction = { parts: [{ text: o.system }] };
  const r = await call(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(body),
  }, o.signal);
  let j: GeminiResponse = {};
  try { j = JSON.parse(r.text) as GeminiResponse; } catch { /* not JSON */ }
  if (!r.ok) throw describeHttp(r.status, j.error?.message ?? r.text);
  if (j.promptFeedback?.blockReason) throw new GeminiError('blocked', `Gemini blocked the request (${j.promptFeedback.blockReason}).`);
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
  if (!text) throw new GeminiError(cand?.finishReason === 'SAFETY' ? 'blocked' : 'bad', `Gemini returned no text${cand?.finishReason ? ` (finish reason ${cand.finishReason})` : ''}.`);
  return text;
}

/** Proves the key works and lists the models that can generate text. */
export async function listModels(apiKey: string, base = GEMINI_BASE, signal?: AbortSignal): Promise<string[]> {
  const r = await call(`${base.replace(/\/+$/, '')}/v1beta/models?pageSize=100`, { headers: { 'x-goog-api-key': apiKey } }, signal);
  let j: { models?: { name: string; supportedGenerationMethods?: string[] }[]; error?: { message?: string } } = {};
  try { j = JSON.parse(r.text); } catch { /* ignore */ }
  if (!r.ok) throw describeHttp(r.status, j.error?.message ?? r.text);
  return (j.models ?? []).filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
}

export const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retries quota / server / network errors with growing pauses (2 s, 6 s, 15 s); anything else fails at once. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: { delays?: number[]; sleep?: (ms: number) => Promise<void>; onRetry?: (e: GeminiError, n: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  const delays = opts.delays ?? [2000, 6000, 15000];
  const sleep = opts.sleep ?? ((ms: number) => sleepAbortable(ms, opts.signal));
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof GeminiError) || !e.retryable || i >= delays.length) throw e;
      opts.onRetry?.(e, i + 1);
      await sleep(delays[i]);
    }
  }
}
