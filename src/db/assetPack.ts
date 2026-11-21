import { viewBoxOf } from '../assets/svgdoc';
import { VIER_PACK_FOLDER, vierPack } from '../assets/vierPack';
import { addFolder } from './assetFolders';
import { storeSvgAsset } from './repo';
import { db } from './schema';

/**
 * Installs the VierApparatus vector pack into the folder "VierAsset", as vector assets. An asset of the same name that is
 * already in that folder is kept as it is (installing twice adds nothing).
 */
export async function installVierPack(onProgress?: (done: number, total: number) => void): Promise<{ added: number; skipped: number }> {
  const have = new Set((await db.assets.where('category').equals(VIER_PACK_FOLDER).toArray()).map((a) => a.name));
  await addFolder(VIER_PACK_FOLDER);
  let added = 0, skipped = 0;
  for (let i = 0; i < vierPack.length; i++) {
    const f = vierPack[i];
    if (have.has(`${f.name}.svg`)) skipped++;
    else {
      const box = viewBoxOf(f.svg);
      await storeSvgAsset(f.svg, f.name, Math.max(1, Math.round(box?.w ?? 200)), Math.max(1, Math.round(box?.h ?? 200)), { category: VIER_PACK_FOLDER, tags: ['vierapparatus', 'science', 'vector'] });
      added++;
    }
    onProgress?.(i + 1, vierPack.length);
  }
  return { added, skipped };
}
