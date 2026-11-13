/**
 * Builds the text shown by the installer's licence page and keeps the in-app copies of the licence / terms in sync.
 *   build/installer-license.txt   (credit + terms + MIT, plain ASCII for the NSIS licence page)
 *   public/TERMS.txt, public/LICENSE.txt   (shown in Settings → About)
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (f) => readFileSync(root + f, 'utf8');
const pkg = JSON.parse(read('package.json'));

mkdirSync(root + 'build', { recursive: true });
const header = [
  `DYNAMIC CANVAS ENGINE  -  version ${pkg.version}`,
  '',
  'Free and open-source software (MIT License).',
  'Concept and product requirements (PRD): Muhammad Satrio.',
  '',
  'PLEASE READ BEFORE INSTALLING.',
  'This software is free and is provided AS IS. The people who conceived,',
  'wrote, contributed to or distribute it are NOT responsible for anything that',
  'happens when you install or use it. To continue you must click "I Agree",',
  'which confirms that you have read and accept the terms on this page.',
  '',
  '==========================================================================',
  '',
].join('\r\n');
// plain ASCII, Windows line endings: the NSIS licence control is picky
const body = (header + read('TERMS.txt')).replace(/\r?\n/g, '\r\n').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');
writeFileSync(root + 'build/installer-license.txt', body, 'ascii');

copyFileSync(root + 'TERMS.txt', root + 'public/TERMS.txt');
copyFileSync(root + 'LICENSE', root + 'public/LICENSE.txt');
console.log('legal texts prepared (' + body.length + ' characters in the installer licence page)');
