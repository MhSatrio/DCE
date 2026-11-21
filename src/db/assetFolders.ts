import { db, getSetting, setSetting } from './schema';

/**
 * Folders of the asset library. A folder is the category of its assets; the folders the user made (and that are still
 * empty) are kept in a setting, so an empty folder stays in the list until it is deleted.
 */
export const FOLDERS_KEY = 'assets.folders';
export const UNFILED = 'Uncategorised';

export async function savedFolders(): Promise<string[]> {
  return getSetting<string[]>(FOLDERS_KEY, []);
}

/** A new folder. Names are trimmed; an empty name or a duplicate is refused with a message. */
export async function addFolder(name: string): Promise<void> {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('Give the folder a name.');
  if (n.length > 60) throw new Error('The folder name is longer than 60 characters.');
  const current = await savedFolders();
  if (current.includes(n)) return;
  await setSetting(FOLDERS_KEY, [...current, n].sort((a, b) => a.localeCompare(b)));
}

/** Deletes a folder; its assets go to "Uncategorised" (nothing is deleted). Returns how many assets moved. */
export async function deleteFolder(name: string): Promise<number> {
  const moved = name === UNFILED ? 0 : await db.assets.where('category').equals(name).modify({ category: UNFILED });
  await setSetting(FOLDERS_KEY, (await savedFolders()).filter((f) => f !== name));
  return moved;
}

/** Every folder: the saved ones and those that hold assets, sorted. */
export function folderNames(assets: { category: string }[], saved: string[]): string[] {
  return [...new Set([...saved, ...assets.map((a) => a.category || UNFILED)])].sort((a, b) => a.localeCompare(b));
}
