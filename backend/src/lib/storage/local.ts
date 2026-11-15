import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import type { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { Storage } from "./index";
import { assertKey } from "./keys";

/**
 * Storage on the local disk, under a root relative to the backend's
 * working directory (like UPLOAD_DIR). Writes go to a temp file first and
 * are renamed into place, so a crash never leaves a half-written key that
 * a retried job would trust.
 */
export class LocalStorage implements Storage {
  readonly driver = "local";
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  localPath(key: string): string {
    return path.join(this.root, ...assertKey(key).split("/"));
  }

  relativePath(key: string): string {
    return path.relative(process.cwd(), this.localPath(key));
  }

  private async writeAtomically(
    key: string,
    write: (tempPath: string) => Promise<void>
  ): Promise<void> {
    const target = this.localPath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });

    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;

    try {
      await write(temp);
      await fsp.rename(temp, target);
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  put(key: string, data: Buffer | string): Promise<void> {
    return this.writeAtomically(key, (temp) => fsp.writeFile(temp, data));
  }

  putStream(key: string, stream: Readable): Promise<void> {
    return this.writeAtomically(key, (temp) =>
      pipeline(stream, fs.createWriteStream(temp))
    );
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fsp.readFile(this.localPath(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fsp.access(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await fsp.rm(this.localPath(key), { force: true });
  }
}
