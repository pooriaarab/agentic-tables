import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createMemoryStore, type AdapterOptions, type Doc, type Store } from "./store.js";

/**
 * A Store kept in one JSON file. It loads once, then rewrites the file after each write. Node only.
 * One process at a time: a second process that writes the same file is not seen by the first.
 */
export function createFileStore(path: string, options: AdapterOptions = {}): Store {
  const initial = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, Doc>>) : {};
  return createMemoryStore({
    ...options,
    initial,
    onChange(snapshot) {
      const temp = `${path}.tmp`;
      writeFileSync(temp, JSON.stringify(snapshot));
      renameSync(temp, path);
    },
  });
}
