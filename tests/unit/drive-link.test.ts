import { describe, expect, it } from 'vitest';
import { directDriveAddress, imageNameFor } from '../../src/db/remote';

const ID = '1sTgkW0aDW7l-_clz_tHSGqlvOdOwxwkA';
const DIRECT = `https://drive.usercontent.google.com/download?id=${ID}&export=download`;

describe('Google Drive share links', () => {
  it('a share link (file/d/…/view) becomes the address that sends the file itself', () => {
    expect(directDriveAddress(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`)).toBe(DIRECT);
    expect(directDriveAddress(`https://drive.google.com/file/d/${ID}/view`)).toBe(DIRECT);
  });

  it('the open?id= and uc?id= forms work too', () => {
    expect(directDriveAddress(`https://drive.google.com/open?id=${ID}`)).toBe(DIRECT);
    expect(directDriveAddress(`https://drive.google.com/uc?export=view&id=${ID}`)).toBe(DIRECT);
  });

  it('a folder link, another site, and an id that is too short are not file links', () => {
    expect(directDriveAddress(`https://drive.google.com/drive/folders/${ID}`)).toBeNull();
    expect(directDriveAddress('https://example.com/photo.jpg')).toBeNull();
    expect(directDriveAddress('https://drive.google.com/file/d/short/view')).toBeNull();
  });
});

describe('file names of imported images', () => {
  it('a Drive file is named after its id, with the extension of its type', () => {
    expect(imageNameFor(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`, 'image/png')).toBe('Google Drive image 1sTgkW0a.png');
  });

  it('a file name in the address is kept', () => {
    expect(imageNameFor('https://img.example.com/products/magnetic-stirrer.JPG', 'image/jpeg')).toBe('magnetic-stirrer.JPG');
  });

  it('an address that ends in a word (view, download) gets a neutral name and the extension of its type', () => {
    expect(imageNameFor('https://img.example.com/shop/view', 'image/webp')).toBe('Web image.webp');
    expect(imageNameFor('https://img.example.com/download', 'image/png')).toBe('download.png');
  });
});
