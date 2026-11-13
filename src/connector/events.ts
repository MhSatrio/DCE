/**
 * An event as the website sends it (see the website connector: GET /api/connector/v1/events). Pure helpers only.
 */
export type ConnectorEvent = { id: number; createdAt: string; type: string; entityId: string; payload: Record<string, unknown> };

export const EVENT_TYPE_TEXT: Record<string, string> = {
  'article.published': 'Article published',
  'product.published': 'Product published',
  'product.reviewed': 'Product reviewed',
};

/** Checks the shape of a received event, so one malformed item cannot stop the others. */
export function isConnectorEvent(x: unknown): x is ConnectorEvent {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return typeof e.id === 'number' && typeof e.type === 'string' && typeof e.entityId === 'string' && !!e.payload && typeof e.payload === 'object';
}

/** The page of an item as the Content pipeline needs it (address, title, short text, picture). */
export function pageOf(ev: ConnectorEvent): { url: string; title: string; excerpt: string; image: string } {
  const p = ev.payload;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    url: str(p.url),
    title: str(p.title) || str(p.name) || ev.entityId,
    excerpt: str(p.excerpt) || str(p.shortDescription),
    image: str(p.image) || str(p.imageUrl),
  };
}

/** The table row that stands for one item: one row per item and event type, so repeating the same event updates the row. */
export const rowIdOf = (ev: ConnectorEvent) => `${ev.type}:${ev.entityId}`;
