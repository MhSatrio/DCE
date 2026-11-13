/**
 * .njs — the canonical DCE design format. The editor (Fabric.js), the database and the renderer
 * all speak this schema; Fabric objects are never persisted.
 */
export const NJS_FORMAT = 'vierapparatus-dce';
export const NJS_VERSION = '1.0.0';

export type NodeType =
  | 'rect' | 'ellipse' | 'line' | 'text' | 'image' | 'polygon' | 'star' | 'frame' | 'path' | 'group' | 'plugin';

export type OverflowPolicy = 'truncate' | 'auto_shrink' | 'multiline' | 'expand' | 'hide';
export type ImageFit = 'cover' | 'contain' | 'fill' | 'crop';
export type MissingImage = 'hide' | 'placeholder' | 'error';

export interface NodeStyle {
  fill?: string;            // CSS colour, or 'none'. For text this is the text colour.
  stroke?: string;
  strokeWidth?: number;
  strokeDash?: number[];
  cornerRadius?: number;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  lineHeight?: number;      // multiplier
  letterSpacing?: number;   // px
  decoration?: 'none' | 'underline' | 'line-through';
  padding?: number;
  [k: string]: unknown;
}

export interface NodeConstraints {
  // text
  maxChars?: number;
  minFontSize?: number;
  maxFontSize?: number;
  maxLines?: number;
  overflow?: OverflowPolicy;
  fallbackText?: string;
  maxExpandHeight?: number;
  // image
  fit?: ImageFit;
  focalX?: number;          // 0..1
  focalY?: number;          // 0..1
  fallbackAssetId?: string;
  missing?: MissingImage;
  [k: string]: unknown;
}

export interface NodeBinding {
  text?: { template: string; fallback?: string };
  image?: { key: string; fallback?: string };
  fill?: { key: string; fallback?: string };
  /** Safe expression, e.g. `content.discount` or `content.status == "Approved"`. */
  visible?: { expr: string };
  [k: string]: unknown;
}

export interface DceNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  locked: boolean;
  opacity: number;
  layer: number;
  style: NodeStyle;
  text?: string;
  src?: { assetId?: string; url?: string };
  sides?: number;
  points?: number;
  innerRatio?: number;
  /** Bézier path: anchors + optional per-anchor handles [inX,inY,outX,outY] (all normalised 0..1 to the node box; null = corner). */
  path?: { points: [number, number][]; closed: boolean; handles?: ([number, number, number, number] | null)[] };
  /** type 'plugin' only: name of a registered render plugin + its parameters. */
  plugin?: { name: string; [k: string]: unknown };
  binding?: NodeBinding;
  constraints?: NodeConstraints;
  children?: DceNode[];
  [k: string]: unknown;
}

export type PlaceholderType = 'text' | 'image' | 'color' | 'boolean' | 'number' | 'date';

export interface Placeholder {
  key: string;
  type: PlaceholderType;
  label: string;
  required: boolean;
  default_value?: string;
  validation?: { pattern?: string; min?: number; max?: number; one_of?: string[] };
  format?: string;
  max_length?: number;
  overflow_strategy?: OverflowPolicy;
  min_font_size?: number;
  [k: string]: unknown;
}

export interface AssetRef {
  id: string;
  name: string;
  mime?: string;
  width?: number;
  height?: number;
  /** Optional data: URI so a .njs file can be fully self-contained. */
  data?: string;
  [k: string]: unknown;
}

export interface NjsMeta {
  id: string;
  name: string;
  author: string;
  created_at: string;
  updated_at: string;
  description?: string;
  tags?: string[];
  [k: string]: unknown;
}

export interface NjsDoc {
  format: typeof NJS_FORMAT;
  version: string;
  meta: NjsMeta;
  canvas: { width: number; height: number; background: string; [k: string]: unknown };
  placeholders: Placeholder[];
  nodes: DceNode[];
  assets: AssetRef[];
  constraints: { snapGrid?: number; palette?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** Data available to bindings. */
export interface RenderData {
  content: Record<string, unknown>;
  template: Record<string, unknown>;
  batch: { index: number; total: number };
}

export interface Issue {
  level: 'warning' | 'error';
  nodeId?: string;
  nodeName?: string;
  message: string;
}
