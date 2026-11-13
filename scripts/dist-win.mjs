/**
 * Builds the Windows installer.  node scripts/dist-win.mjs
 *
 * The output goes to  <your home folder>/DCE-release  (override with DCE_OUT=...), deliberately OUTSIDE this project:
 * if the project lives in OneDrive / Dropbox, the sync client locks the freshly written files and the packager fails with
 * EPERM, and ~400 MB of build output would be uploaded for nothing.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = process.env.DCE_OUT || join(homedir(), 'DCE-release');
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('npm', ['run', 'build']);
run('node', ['scripts/prepare-legal.mjs']);
run('npx', ['electron-builder', '--win', 'nsis', '--x64', `--config.directories.output=${out}`]);
console.log(`\nInstaller written to: ${out}`);
