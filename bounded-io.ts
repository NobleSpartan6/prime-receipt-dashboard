import { open } from "node:fs/promises";

/**
 * Read one regular file through one opened handle with a hard byte ceiling.
 *
 * The same handle is used for stat and read, so replacing the pathname after
 * validation cannot swap in a different file. The read itself is capped at
 * maxBytes + 1, so growth after stat cannot cause unbounded allocation.
 */
export async function readUtf8Bounded(path: string, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError("maxBytes must be a non-negative safe integer");

  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error(`${path} is not a regular file`);
    if (metadata.size > maxBytes) throw new Error(`${path} exceeds ${maxBytes} bytes`);

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`${path} exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}
