import { describe, expect, it } from 'vitest';
import { carouselGroupId, planCarousel } from '../../src/db/carousel';
import type { ContentRecord } from '../../src/db/schema';

const rec = (id: string, url: string | undefined): ContentRecord => ({
  id, title: id, slug: '', status: 'Draft', publish_date: '', content: '', image_asset: '', template_ref: '', tags: [], created_at: 1, updated_at: 1,
  data: url === undefined ? {} : { image_url: url }, table: 't1',
});

describe('carousel grouping (planCarousel)', () => {
  const CID = 'car1';

  it('100 images with 10 per carousel make exactly 10 carousels of 10 consecutive images', () => {
    const recs = Array.from({ length: 100 }, (_, i) => rec(`img${i + 1}`, `https://cdn.example/${i + 1}.png`));
    const plan = planCarousel(recs, 'image_url', 10, CID);
    expect(plan.groups).toHaveLength(10);
    expect(plan.groups[0].id).toBe(carouselGroupId(CID, 1));
    expect(plan.groups.every((g) => g.urls.length === 10)).toBe(true);
    expect(plan.groups[0].members.slice(0, 2)).toEqual(['img1', 'img2']);
    expect(plan.groups[9].members.at(-1)).toBe('img100');
  });

  it('every image gets its page: Image 1 is page 1, Image 11 is page 2 of carousel 2 (its own group id)', () => {
    const recs = Array.from({ length: 12 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    const plan = planCarousel(recs, 'image_url', 10, CID);
    expect(plan.pages.get('img1')).toEqual({ groupId: carouselGroupId(CID, 1), page: 1 });
    expect(plan.pages.get('img10')).toEqual({ groupId: carouselGroupId(CID, 1), page: 10 });
    expect(plan.pages.get('img11')).toEqual({ groupId: carouselGroupId(CID, 2), page: 1 });
    expect(plan.pages.get('img12')).toEqual({ groupId: carouselGroupId(CID, 2), page: 2 });
  });

  it('an incomplete last group keeps what it has; no image is counted twice', () => {
    const recs = Array.from({ length: 23 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    const plan = planCarousel(recs, 'image_url', 10, CID);
    expect(plan.groups.map((g) => g.urls.length)).toEqual([10, 10, 3]);
    const all = plan.groups.flatMap((g) => g.members);
    expect(new Set(all).size).toBe(23);
  });

  it('records without a URL are part of no carousel, and do not shift the pages', () => {
    const recs = [rec('a', 'u1'), rec('b', undefined), rec('c', '   '), rec('d', 'u2')];
    const plan = planCarousel(recs, 'image_url', 6, CID);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].members).toEqual(['a', 'd']);
    expect(plan.pages.has('b')).toBe(false);
    expect(plan.pages.get('d')).toEqual({ groupId: carouselGroupId(CID, 1), page: 2 });
  });

  it('is repeatable: the same source gives the same groups and ids, so a sync never duplicates a carousel', () => {
    const recs = Array.from({ length: 7 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    expect(planCarousel(recs, 'image_url', 3, CID)).toEqual(planCarousel(recs, 'image_url', 3, CID));
    expect(planCarousel(recs, 'image_url', 3, CID).groups.map((g) => g.id)).toEqual([carouselGroupId(CID, 1), carouselGroupId(CID, 2), carouselGroupId(CID, 3)]);
  });

  it('a removed source record moves the images after it into the groups before them (no stale members)', () => {
    const recs = Array.from({ length: 4 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    const before = planCarousel(recs, 'image_url', 2, CID);
    const after = planCarousel(recs.filter((r) => r.id !== 'img1'), 'image_url', 2, CID);
    expect(before.groups[0].members).toEqual(['img1', 'img2']);
    expect(after.groups[0].members).toEqual(['img2', 'img3']);
    expect(after.groups).toHaveLength(2);
  });

  it('a group size outside 1–50 is clamped, so a bad setting cannot produce an endless split', () => {
    const recs = Array.from({ length: 3 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    expect(planCarousel(recs, 'image_url', 0, CID).groups).toHaveLength(3);
    expect(planCarousel(recs, 'image_url', 999, CID).groups).toHaveLength(1);
  });
});

describe('closing slide (planCarousel with a closing URL)', () => {
  const CID = 'car1';
  const CTA = 'https://cdn.example/cta.png';

  it('1–10 with a closing image: every carousel is 9 images from the table, then the closing image as slide 10', () => {
    const recs = Array.from({ length: 18 }, (_, i) => rec(`img${i + 1}`, `https://cdn.example/${i + 1}.png`));
    const plan = planCarousel(recs, 'image_url', 10, CID, CTA);
    expect(plan.groups).toHaveLength(2);
    for (const g of plan.groups) {
      expect(g.urls).toHaveLength(10);
      expect(g.urls.at(-1)).toBe(CTA);
    }
    expect(plan.groups[0].urls[0]).toBe('https://cdn.example/1.png');
    expect(plan.groups[0].urls[8]).toBe('https://cdn.example/9.png');
    expect(plan.groups[1].urls[0]).toBe('https://cdn.example/10.png');
    expect(plan.groups[0].members).toHaveLength(9);
  });

  it('the closing image is not a source record: pages still count the table images only (image 10 is page 1 of carousel 2)', () => {
    const recs = Array.from({ length: 10 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    const plan = planCarousel(recs, 'image_url', 10, CID, CTA);
    expect(plan.pages.get('img9')).toEqual({ groupId: carouselGroupId(CID, 1), page: 9 });
    expect(plan.pages.get('img10')).toEqual({ groupId: carouselGroupId(CID, 2), page: 1 });
    expect(plan.groups[1].urls).toEqual(['u10', CTA]);
  });

  it('a last carousel that holds few images still ends with the closing image', () => {
    const recs = Array.from({ length: 11 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    const plan = planCarousel(recs, 'image_url', 10, CID, CTA);
    expect(plan.groups.map((g) => g.urls.length)).toEqual([10, 3]);
    expect(plan.groups[1].urls).toEqual(['u10', 'u11', CTA]);
  });

  it('without a closing URL nothing changes; a closing image with a size of 1 has no room, so it is left out', () => {
    const recs = Array.from({ length: 4 }, (_, i) => rec(`img${i + 1}`, `u${i + 1}`));
    expect(planCarousel(recs, 'image_url', 3, CID)).toEqual(planCarousel(recs, 'image_url', 3, CID, undefined));
    expect(planCarousel(recs, 'image_url', 1, CID, CTA).groups.map((g) => g.urls)).toEqual([['u1'], ['u2'], ['u3'], ['u4']]);
    expect(planCarousel(recs, 'image_url', 3, CID, '   ').groups[0].urls).toEqual(['u1', 'u2', 'u3']);
  });
});
