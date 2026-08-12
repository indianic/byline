import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml';
import { SLUG_PATTERN, SLUG_RULE } from './sites.js';
import { ToolError } from '../errors.js';
import { isPathInside } from '../media/library.js';

export interface LibraryEntry {
  name: string;
  /** Absolute path, already expanded by the caller. */
  path: string;
  recursive?: boolean;
  /**
   * Where the derived index and the usage ledger go, instead of
   * `<byline home>/media/`. Absolute, already expanded by the caller. Written
   * as `index_path`, and refused when it resolves inside `path` — byline never
   * writes inside a user's library folder.
   */
  indexPath?: string;
  setDefault?: boolean;
}

type ConfigDoc = ReturnType<typeof parseDocument>;

/**
 * The ONE writer of a `media.libraries` entry.
 *
 * Sibling of `site-block.ts`, and for the same reason: two hand-written copies
 * of "how a block gets written" is exactly how `init` and `add_site` drifted,
 * and that drift silently replaced a Ghost site with a WordPress one.
 *
 * Uses `parseDocument` rather than `parse` + re-serialise, so comments and key
 * order in a config the user has edited by hand survive the write.
 */
function loadDoc(configFile: string): ConfigDoc {
  if (!existsSync(configFile)) {
    throw new ToolError({
      api: 'config',
      code: 'CONFIG_NOT_FOUND',
      message: `No config file at ${configFile}.`,
      // NOT just "run `byline init`": init writes config.yaml from the
      // add-a-blog path (src/cli/init.ts), so someone who ran it and only
      // registered their AI tools has no config.yaml, and would be told to run
      // the command they just ran.
      hint: 'Run `byline init` and add a blog — config.yaml is written when the first blog is added.',
    });
  }
  return parseDocument(readFileSync(configFile, 'utf8'));
}

/**
 * Return the `media` map node, creating it if absent.
 *
 * `Document#set` does NOT wrap a plain JS object into a `YAMLMap` node -- it
 * stores the raw object as the pair's value. `doc.get('media')` would then
 * hand back that same plain object, which has no `.has`/`.get`/`.set` of its
 * own, and the very next call in this function would throw. `doc.createNode`
 * performs the wrap explicitly, so the node we get back behaves like every
 * other map in the document, including ones that came from parsing existing
 * YAML text.
 */
function ensureMediaMap(doc: ConfigDoc): YAMLMap {
  if (!doc.has('media')) {
    doc.set('media', doc.createNode({ libraries: [] }));
  }
  const media = doc.get('media');
  if (!isMap(media)) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: '"media" in the config is not a mapping.',
      hint: 'Fix or remove the `media:` block by hand and try again.',
    });
  }
  return media;
}

/** Same wrapping concern as {@link ensureMediaMap}, one level down. */
function ensureLibrariesSeq(doc: ConfigDoc, media: YAMLMap): YAMLSeq {
  if (!media.has('libraries')) {
    media.set('libraries', doc.createNode([]));
  }
  const libraries = media.get('libraries');
  if (!isSeq(libraries)) {
    throw new ToolError({
      api: 'config',
      code: 'INVALID_CONFIG',
      message: '"media.libraries" in the config is not a list.',
      hint: 'Fix or remove the `media:` block by hand and try again.',
    });
  }
  return libraries;
}

/**
 * Add one library. Returns the warnings the caller should show the user.
 *
 * There is no success flag in the return: every way this can fail throws a
 * `ToolError` naming the fault, so a returned value means the file was written.
 * A `{ written: true }` that no branch could ever set to `false` said nothing,
 * and a caller reading it would have been checking a constant.
 */
export function addLibraryToConfig(
  configFile: string,
  entry: LibraryEntry,
): { warnings: string[] } {
  if (!SLUG_PATTERN.test(entry.name)) {
    throw new ToolError({
      api: 'config',
      code: 'BAD_LIBRARY_NAME',
      message: `"${entry.name}" is not a legal media library name. ${SLUG_RULE}`,
      hint: 'Pass --name with a different value.',
    });
  }
  if (!existsSync(entry.path)) {
    throw new ToolError({
      api: 'config',
      code: 'LIBRARY_PATH_MISSING',
      message: `${entry.path} does not exist.`,
      hint: 'Create the folder first, or point at one that already holds your photographs.',
    });
  }
  if (!statSync(entry.path).isDirectory()) {
    throw new ToolError({
      api: 'config',
      code: 'LIBRARY_PATH_NOT_DIR',
      message: `${entry.path} is not a directory.`,
      hint: 'A media library is a folder, not a single file.',
    });
  }
  // Refused at WRITE time as well as at load. `loadMedia` already marks such a
  // library unavailable, but letting the write through would mean this command
  // cheerfully creating a config that the very next command reports as broken.
  // `isPathInside` is imported, not reimplemented: one rule, one definition —
  // and a second hand-written copy would be free to drift into a plain string
  // prefix check, which treats `/photos-backup` as nested inside `/photos`.
  if (entry.indexPath && isPathInside(entry.indexPath, entry.path)) {
    throw new ToolError({
      api: 'config',
      code: 'INDEX_PATH_INSIDE_LIBRARY',
      message: `${entry.indexPath} is inside the library folder ${entry.path}; byline must never write inside a library folder.`,
      hint: 'Point --index-path at a folder outside the library — the default, ~/.byline/media/, already is one.',
    });
  }

  const doc = loadDoc(configFile);
  const warnings: string[] = [];

  const media = ensureMediaMap(doc);
  const libraries = ensureLibrariesSeq(doc, media);

  const existing = (libraries.toJSON() ?? []) as Array<{ name?: string }>;

  if (existing.some((l) => l?.name === entry.name)) {
    throw new ToolError({
      api: 'config',
      code: 'LIBRARY_EXISTS',
      message: `A media library named "${entry.name}" is already configured.`,
      hint: `Pick another name, or run \`byline media remove ${entry.name}\` first.`,
    });
  }

  libraries.add(
    doc.createNode({
      name: entry.name,
      path: entry.path,
      ...(entry.recursive === false ? { recursive: false } : {}),
      ...(entry.indexPath ? { index_path: entry.indexPath } : {}),
    }),
  );

  // The first library becomes the default, because a user with exactly one
  // should never have to name it -- and `getLibrary` already resolves a sole
  // library without a default, so this only makes the file say what is
  // already true. A second library must never move the default.
  const isFirst = existing.length === 0;
  if (entry.setDefault || isFirst) {
    if (!media.has('default_library') || entry.setDefault) {
      media.set('default_library', entry.name);
      if (isFirst && !entry.setDefault) {
        warnings.push(`"${entry.name}" is now the default library.`);
      }
    }
  }

  writeFileSync(configFile, String(doc));
  return { warnings };
}

export function removeLibraryFromConfig(configFile: string, name: string): boolean {
  const doc = loadDoc(configFile);
  if (!doc.has('media')) return false;

  const media = doc.get('media');
  // Returns false for malformed config (deliberate asymmetry with addLibraryToConfig):
  // remove's contract is boolean (found/not-found), so refusing to forget when the
  // file is malformed would trap the user. Returning false lets them fix the file and retry.
  if (!isMap(media)) return false;

  const librariesNode = media.get('libraries');
  if (!isSeq(librariesNode)) return false;

  // Deleted from the sequence IN PLACE. `media.set('libraries', kept)` — where
  // `kept` came out of `toJSON()` — replaced the whole node with a plain array,
  // and every comment in the block died with it. This file's header promises a
  // hand-edited config survives the write; that was true for `add` and false
  // for `remove`. Splicing leaves every surviving item's own node, and the
  // comments attached to it, exactly as parsed.
  //
  // Backwards, and every match: a config CAN name the same library twice
  // (`loadMedia` reports it and uses the last), so forgetting one copy and
  // leaving the other would make `remove` look like it had done nothing.
  const items = librariesNode.items;
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (isMap(item) && item.get('name') === name) {
      items.splice(i, 1);
      removed += 1;
    }
  }
  if (removed === 0) return false;

  if (media.get('default_library') === name) media.delete('default_library');

  // Only the config entry is removed. Nothing under the library `path` is
  // touched -- byline never writes inside a user's library folder, and that
  // includes deleting it.
  writeFileSync(configFile, String(doc));
  return true;
}
