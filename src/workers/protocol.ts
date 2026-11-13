import type { FontPayload } from '../engine/fonts';
import type { Issue, NjsDoc, RenderData } from '../engine/types';
import type { EngineFormat } from '../engine/render';

export interface WorkerOpts {
  format: EngineFormat;
  outW: number;
  outH: number;
  quality: number;
  transparent: boolean;
  fontCss?: string;
}

export type ToWorker =
  | { type: 'setup'; doc: NjsDoc; opts: WorkerOpts; fonts: FontPayload[] }
  | { type: 'render'; seq: number; data: RenderData; blobs: Record<string, Blob> };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'done'; seq: number; bytes: ArrayBuffer; ext: string; width: number; height: number; issues: Issue[]; ms: number }
  | { type: 'fail'; seq: number; error: string; issues: Issue[] }
  | { type: 'fatal'; error: string };
