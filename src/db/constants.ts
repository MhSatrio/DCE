/**
 * Internal id of the Content Plan table. It is a storage name, never shown; the table's name can be changed
 * (Settings, or Rename table in the Content Plan header) and the new name is kept as a setting.
 */
export const CONTENT_TABLE = 'content';

/** The name the Content Plan starts with, until it is renamed. */
export const DEFAULT_CONTENT_NAME = 'Content Plan';

/** Settings key that holds the Content Plan's name once it is renamed. */
export const CONTENT_NAME_KEY = 'table.content.name';
