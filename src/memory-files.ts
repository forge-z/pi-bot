import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { hash } from "./store.js";

export const MEMORY_FILE = "MEMORY.md";
export const MEMORY_LIMIT = 8_000;
const DAILY_CONTEXT_LIMIT = 2_000;
const DAILY_TRUNCATED = "[Earlier daily notes truncated]\n";
const FILE_LIMIT = 64_000;
const DAILY = /^\d{4}-\d{2}-\d{2}\.md$/;

export interface MemoryWrite {
  name: string;
  before: string;
  after: string;
}

export function memoryKey(line: string) {
  return line
    .replace(/^\s*[-*+]\s+/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class MemoryFiles {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = join(dir, "memory");
  }

  private directory(create: boolean) {
    if (create) {
      try {
        mkdirSync(this.dir, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      if (!lstatSync(this.dir).isDirectory())
        throw new Error("Unsafe memory directory");
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  private path(name: string) {
    if (name !== MEMORY_FILE && !DAILY.test(name))
      throw new Error("Invalid memory file name");
    return join(this.dir, name);
  }

  read(name: string, limit = FILE_LIMIT, fromEnd = false) {
    const path = this.path(name);
    if (!this.directory(false)) return "";
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (missing(error)) return "";
      throw error;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error("Unsafe memory file");
      if (limit === FILE_LIMIT && stat.size > FILE_LIMIT)
        throw new Error("Memory file too large");
      const truncated = fromEnd && stat.size > limit;
      const budget = truncated ? limit - DAILY_TRUNCATED.length : limit;
      const data = Buffer.alloc(Math.min(stat.size, budget));
      const offset = fromEnd ? stat.size - data.length : 0;
      let length = 0;
      while (length < data.length) {
        const count = readSync(
          fd,
          data,
          length,
          data.length - length,
          offset + length,
        );
        if (!count) break;
        length += count;
      }
      let start = 0;
      if (truncated) {
        while (start < length && (data[start] & 0xc0) === 0x80) start++;
      }
      return (
        (truncated ? DAILY_TRUNCATED : "") +
        data.toString("utf8", start, length)
      );
    } finally {
      closeSync(fd);
    }
  }

  readDailyContext(name: string) {
    return this.read(name, DAILY_CONTEXT_LIMIT, true);
  }

  private dailyNames() {
    if (!this.directory(false)) return [];
    return readdirSync(this.dir)
      .filter((name) => DAILY.test(name))
      .sort()
      .reverse();
  }

  apply({ name, before, after }: MemoryWrite) {
    const path = this.path(name);
    const current = this.read(name);
    if (current === after || hash(current) !== before) return;
    this.directory(true);
    const temp = join(this.dir, `.write-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, after);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      const directory = openSync(
        this.dir,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    }
  }

  search(query: string) {
    const words =
      query
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!words.length) return [];
    const results: { file: string; text: string }[] = [];
    for (const name of this.dailyNames()) {
      let lines: string[];
      try {
        lines = this.read(name).split(/\r?\n/);
      } catch {
        continue;
      }
      for (const line of lines) {
        const tokens = new Set(
          line
            .normalize("NFKC")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu),
        );
        if (words.every((word) => tokens.has(word)))
          results.push({ file: name, text: line.slice(0, 500) });
        if (results.length === 12) return results;
      }
    }
    return results;
  }

  forget(text: string) {
    const query = memoryKey(text);
    if (!query || query.startsWith("#")) return 0;
    let removed = 0;
    for (const name of [MEMORY_FILE, ...this.dailyNames()]) {
      const before = this.read(name);
      let matches = 0;
      const after = before
        .split(/\r?\n/)
        .filter((line) => {
          const key = memoryKey(line);
          if (key.startsWith("#") || !key.includes(query)) return true;
          matches++;
          return false;
        })
        .join("\n");
      if (matches) this.apply({ name, before: hash(before), after });
      removed += matches;
    }
    return removed;
  }
}
