import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { createMemoryStore, type AdapterOptions, type Doc, type Store } from "./store.js";

type Snapshot = Record<string, Record<string, Doc>>;

export interface FileStoreOptions extends AdapterOptions {
  /** How long a write waits for the lock before it fails. Defaults to 10000. */
  lockTimeoutMs?: number;
  /** A lock older than this is stale, if its owner is alive. Defaults to 30000. */
  staleAfterMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

/**
 * A lock is stale only when its content is well formed and its owner is gone or it is old.
 * Content that does not parse, or has a bad pid or time, counts as a LIVE lock: never take it.
 */
function lockIsStale(text: string, staleAfterMs: number): boolean {
  let held: { pid?: unknown; at?: unknown };
  try {
    held = JSON.parse(text) as typeof held;
  } catch {
    return false;
  }
  if (typeof held !== "object" || held === null) return false;
  const { pid, at } = held;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1 || typeof at !== "number" || !Number.isFinite(at)) return false;
  return !processIsAlive(pid) || Date.now() - at > staleAfterMs;
}

/**
 * A Store kept in one JSON file. Node only. Many processes may share the file, for example the CLI
 * and the MCP server. Each write takes a lock file, reads the file again, applies the change, and
 * replaces the file by an atomic rename. A read sees the last renamed file, so it takes no lock.
 * Each call reads the whole file, so cost grows with its size. Use it for local work, not for scale.
 * The lock needs one machine: the process check and the clock do not work across hosts.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): Store {
  const region = options.region ?? "eu";
  const lockPath = `${path}.lock`;
  const timeoutMs = options.lockTimeoutMs ?? 10_000;
  const staleAfterMs = options.staleAfterMs ?? 30_000;
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<Snapshot> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (codeOf(error) === "ENOENT") return {};
      throw error;
    }
    try {
      const data: unknown = JSON.parse(text);
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error();
      return data as Snapshot;
    } catch {
      // Never replace a file that does not parse: that would erase data an operator may repair.
      throw new Error(`the database file ${path} is not valid JSON. Repair or remove it`);
    }
  }

  async function save(snapshot: Snapshot): Promise<void> {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(JSON.stringify(snapshot));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  /** Move a stale lock aside. Put it back if it changed hands in the meantime. */
  async function takeOverIfStale(): Promise<void> {
    let seen: string;
    try {
      seen = await readFile(lockPath, "utf8");
    } catch {
      return;
    }
    if (!lockIsStale(seen, staleAfterMs)) return;
    const aside = `${lockPath}.stale.${randomUUID()}`;
    try {
      await rename(lockPath, aside);
    } catch {
      return;
    }
    if ((await readFile(aside, "utf8").catch(() => "")) !== seen) await link(aside, lockPath).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
  }

  async function acquire(): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now(), token }));
        } finally {
          await handle.close();
        }
        return token;
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error;
      }
      await takeOverIfStale();
      if (Date.now() > deadline) throw new Error(`the database file is locked. If no agentic-tables process runs, remove ${lockPath}`);
      await sleep(5 + Math.random() * 15);
    }
  }

  async function release(token: string): Promise<void> {
    // Remove the lock only if it is still ours. A takeover may have replaced it.
    const text = await readFile(lockPath, "utf8").catch(() => "");
    if (text.includes(`"token":"${token}"`)) await unlink(lockPath).catch(() => undefined);
  }

  /** Run one change against a fresh copy of the file, under the lock, and save it if it wrote. */
  const mutate = <R>(change: (store: Store) => Promise<R>): Promise<R> => {
    const run = queue.then(async () => {
      const token = await acquire();
      try {
        let changed: Snapshot | undefined;
        const result = await change(createMemoryStore({ region, initial: await load(), onChange: (snapshot) => (changed = snapshot) }));
        if (changed) await save(changed);
        return result;
      } finally {
        await release(token);
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const view = async <R>(read: (store: Store) => Promise<R>): Promise<R> => read(createMemoryStore({ region, initial: await load() }));

  return {
    region,
    get: (collection, id) => view((s) => s.get(collection, id)),
    query: (collection, query) => view((s) => s.query(collection, query)),
    put: (collection, id, doc) => mutate((s) => s.put(collection, id, doc)),
    delete: (collection, id) => mutate((s) => s.delete(collection, id)),
    transaction: (fn) => mutate((s) => s.transaction(fn)),
  };
}
