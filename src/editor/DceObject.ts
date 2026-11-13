import { FabricObject } from 'fabric';
import { drawItemLocal } from '../engine/draw';
import { buildItem, imageRefsFor, type SceneEnv } from '../engine/scene';
import type { DceNode, NjsDoc, RenderData } from '../engine/types';

/** What a canvas object needs from the editor to draw itself with the shared engine. */
export interface DceHost {
  doc(): NjsDoc;
  data(): RenderData | null;
  env: SceneEnv;
  requestImage(ref: string): void;
}

/**
 * The single Fabric class used for every node type. Fabric supplies selection, handles, rotation and hit
 * testing; the pixels come from the same engine (`buildItem` + `drawItemLocal`) that renders batches, so the
 * canvas is truly WYSIWYG — not an approximation made of Fabric's own text and shapes.
 */
export class DceObject extends FabricObject {
  node: DceNode;
  host: DceHost;
  hiddenByData = false;

  constructor(node: DceNode, host: DceHost) {
    super({
      originX: 'center', originY: 'center', objectCaching: false,
      width: node.width, height: node.height,
      borderColor: '#4570B6', cornerColor: '#FFFFFF', cornerStrokeColor: '#4570B6', cornerSize: 9, cornerStyle: 'rect',
      transparentCorners: false, borderScaleFactor: 1.5, padding: 0, strokeWidth: 0, lockSkewingX: true, lockSkewingY: true,
    });
    this.node = node;
    this.host = host;
  }

  _render(ctx: CanvasRenderingContext2D): void {
    const node = this.node;
    const data = this.host.data();
    const live: DceNode = { ...node, width: this.width, height: this.height };
    if (node.type === 'image' || node.type === 'frame') {
      const r = imageRefsFor(live, data ? ((data as unknown) as Record<string, unknown>) : null);
      if (r.primary) this.host.requestImage(r.primary);
      if (r.fallback) this.host.requestImage(r.fallback);
    }
    const { item } = buildItem(live, this.host.doc(), data, this.host.env);
    this.hiddenByData = !item;
    if (!item) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(100,116,139,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-this.width / 2, -this.height / 2, this.width, this.height);
      ctx.restore();
      return;
    }
    ctx.save();
    ctx.translate(-this.width / 2, -this.height / 2);
    item.w = this.width;
    drawItemLocal(ctx, item);
    ctx.restore();
  }
}
