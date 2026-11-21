import { describe, expect, it } from 'vitest';
import { buildCreatePost } from '../../src/automation/buffer';
import { BUFFER_MAX_IMAGES, bufferAddressOf, bufferImageProblem, imageLinksOf } from '../../src/automation/model';

describe('image addresses Buffer can read', () => {
  it('a Google Drive file link is sent in its direct-download form, and that address is accepted', () => {
    const ID = 'FILE000001XY';
    const direct = `https://drive.usercontent.google.com/download?id=${ID}&export=download`;
    expect(bufferAddressOf(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`)).toBe(direct);
    expect(bufferAddressOf(`https://drive.google.com/uc?export=view&id=${ID}`)).toBe(direct);
    expect(bufferImageProblem(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`)).toBeNull();
    expect(bufferImageProblem(direct)).toBeNull();
  });

  it('a Google Drive folder or page, and a Google Docs page, are refused with the reason', () => {
    expect(bufferImageProblem('https://drive.google.com/drive/folders/FOLDER000001XY')).toMatch(/Google Drive folder or page/);
    expect(bufferImageProblem('https://drive.google.com/uc?export=view&id=A')).toMatch(/Google Drive folder or page/);
    expect(bufferImageProblem('https://docs.google.com/document/d/FILE000001XY')).toMatch(/Google Docs page/);
  });

  it('Dropbox links are refused with the reason; a public file is accepted', () => {
    expect(bufferImageProblem('https://www.dropbox.com/s/x/a.png?dl=0')).toMatch(/Dropbox link/);
    expect(bufferImageProblem('https://pub.example.com/batch/card1.png')).toBeNull();
    expect(bufferImageProblem('not a link')).toMatch(/not a web address/);
  });
});

describe('image links of a Buffer post', () => {
  it('one link, or several separated by commas, spaces or new lines (a carousel), keeps their order', () => {
    expect(imageLinksOf('https://a.test/1.jpg').links).toEqual(['https://a.test/1.jpg']);
    expect(imageLinksOf('https://a.test/1.jpg, https://a.test/2.jpg;https://a.test/3.jpg\nhttps://a.test/4.jpg').links)
      .toEqual(['https://a.test/1.jpg', 'https://a.test/2.jpg', 'https://a.test/3.jpg', 'https://a.test/4.jpg']);
  });

  it('a Google Drive link written by the Batch Runner is a valid link', () => {
    const drive = 'https://drive.google.com/uc?export=view&id=FILE000001XY';
    expect(imageLinksOf(`${drive},${drive}`).links).toEqual([drive, drive]);
  });

  it('anything that is not public https is left out, and the notes say so', () => {
    const got = imageLinksOf('http://a.test/1.jpg, https://a.test/2.jpg, 6');
    expect(got.links).toEqual(['https://a.test/2.jpg']);
    expect(got.notes.join(' ')).toMatch(/2 image addresses are not a public https/);
    const none = imageLinksOf('6');
    expect(none.links).toEqual([]);
    expect(none.notes.join(' ')).toMatch(/goes without an image/);
    expect(imageLinksOf('').notes).toEqual([]);
  });

  it('Buffer takes at most ten images: the first ten are sent, and the note says so', () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://a.test/${i}.jpg`).join(',');
    const got = imageLinksOf(many);
    expect(got.links.length).toBe(BUFFER_MAX_IMAGES);
    expect(got.notes.join(' ')).toMatch(/at most 10 images/);
  });

  it('an Instagram post carries its type; other posts carry none', () => {
    expect(buildCreatePost({ text: 'x', channelId: 'c', mode: 'queue', instagramType: 'reel' })).toContain('metadata: { instagram: { type: reel, shouldShareToFeed: true } }');
    expect(buildCreatePost({ text: 'x', channelId: 'c', mode: 'queue', instagramType: 'story' })).toContain('metadata: { instagram: { type: story, shouldShareToFeed: false } }');
    expect(buildCreatePost({ text: 'x', channelId: 'c', mode: 'queue' })).not.toContain('metadata');
  });

  it('a post with several images has one asset per image in the request', () => {
    const q = buildCreatePost({ text: 'carousel', channelId: 'c', mode: 'queue', imageUrls: ['https://a.test/1.jpg', 'https://a.test/2.jpg'] });
    expect(q).toContain('assets: [{ image: { url: "https://a.test/1.jpg" } }, { image: { url: "https://a.test/2.jpg" } }]');
    expect(buildCreatePost({ text: 'no image', channelId: 'c', mode: 'queue', imageUrls: [] })).not.toContain('assets');
  });
});
