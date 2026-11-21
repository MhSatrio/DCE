import { describe, expect, it } from 'vitest';
import { sameFileAt } from '../../src/cloud/addresses';

const DEV = 'https://pub-67c6aefa28a84a17950b9b5326462f1e.r2.dev';
const OWN = 'https://carousel.vierapparatus.com';

describe('a link on a Cloudflare development address', () => {
  it('is the same file under the bucket’s own domain, with the path (the key) kept', () => {
    expect(sameFileAt(`${DEV}/batch/what-is-biotech.jpg`, OWN)).toBe(`${OWN}/batch/what-is-biotech.jpg`);
    expect(sameFileAt(`${DEV}/a%20b.jpg?x=1`, `${OWN}/`)).toBe(`${OWN}/a%20b.jpg?x=1`);
  });

  it('is not changed when the bucket’s address is a development address too, or the link already uses it', () => {
    expect(sameFileAt(`${DEV}/a.jpg`, DEV)).toBeNull();
    expect(sameFileAt(`${OWN}/a.jpg`, OWN)).toBeNull();
    expect(sameFileAt(`${DEV}/a.jpg`, 'https://pub-other.r2.dev')).toBeNull();
  });

  it('a link on another site, or a bad address, is not changed', () => {
    expect(sameFileAt('https://img.example.test/a.jpg', OWN)).toBeNull();
    expect(sameFileAt('not a link', OWN)).toBeNull();
    expect(sameFileAt(`${DEV}/a.jpg`, 'not a base')).toBeNull();
  });
});
