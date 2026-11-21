import { z } from 'zod';
import { nodeSchema } from '../engine/njs';
import type { DceNode } from '../engine/types';

/**
 * Design objects on the system clipboard. They travel as plain text (a small JSON document), so they can be pasted into another
 * DCE tab, window or installed app, and a pasted text is checked against the same schema as a saved design before anything is
 * added: other text on the clipboard, or damaged JSON, is simply not ours and nothing happens.
 * An image object keeps the id of its library asset; pasted into a browser that does not have that asset it shows the usual
 * "missing image" handling.
 */
export const CLIP_VERSION = 1;
export const MAX_PASTED_NODES = 500;
export const MAX_CLIP_CHARS = 2_000_000;

export function encodeNodes(nodes: DceNode[]): string {
  return JSON.stringify({ dceClipboard: CLIP_VERSION, nodes });
}

/** The objects in a clipboard text, or null when the text is not a DCE clipboard payload or does not pass the schema. */
export function decodeNodes(text: string): DceNode[] | null {
  if (!text || text.length > MAX_CLIP_CHARS || !text.startsWith('{"dceClipboard"')) return null;
  try {
    const j = JSON.parse(text) as { dceClipboard?: number; nodes?: unknown };
    if (j.dceClipboard !== CLIP_VERSION) return null;
    const r = z.array(nodeSchema).min(1).max(MAX_PASTED_NODES).safeParse(j.nodes);
    return r.success ? r.data : null;
  } catch { return null; }
}
