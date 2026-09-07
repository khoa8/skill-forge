/**
 * Shared bounded response-body reading for source adapters.
 *
 * Content-length headers are advisory: a hostile or misbehaving server can
 * omit them (or lie) and stream unbounded data. The byte cap must therefore
 * be enforced WHILE the body streams, not after it is fully buffered —
 * overflowing connections are torn down (reader cancelled) so memory stays
 * bounded regardless of what the server sends.
 *
 * Errors are domain-neutral here; each adapter maps them onto its own typed
 * error family (UrlSourceError / GithubSourceError).
 */

/** Thrown when a response body exceeds the caller's byte cap. */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeded the ${maxBytes} byte limit.`);
    this.name = "BodyTooLargeError";
  }
}

type ChunkReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

/**
 * Read one stream chunk, racing the reader against an optional abort signal so
 * a stalled body (stream that never ends) cannot outlive the caller's deadline
 * even if the runtime does not propagate the abort into the stream itself.
 */
function readChunkWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ChunkReadResult> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort);
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Structural shape readBodyCapped needs: a WHATWG Response (GitHub adapter)
 * or a custom transport response exposing a `body` stream. `text()` is only
 * consulted when no stream exists (manually constructed test responses).
 */
export interface CappedBodyLike {
  body?: ReadableStream<Uint8Array> | null;
  text?(): Promise<string>;
}

/**
 * Read a response body fully, refusing early (and cancelling the underlying
 * stream) once more than maxBytes has been received. Returns the exact bytes
 * received; the caller decodes/parses them.
 *
 * `signal` (optional) bounds stalled bodies: if it aborts mid-read, the read
 * rejects with the abort reason and the stream is cancelled.
 *
 * Read failures (network reset, abort) propagate verbatim so each adapter can
 * apply its existing deadline/error mapping.
 */
export async function readBodyCapped(
  res: CappedBodyLike,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("aborted", "AbortError");
  }
  const body = res.body;
  if (!body) {
    // Manually constructed Response shapes (some tests) expose no stream.
    const bytes = new TextEncoder().encode(res.text ? await res.text() : "");
    if (bytes.byteLength > maxBytes) throw new BodyTooLargeError(maxBytes);
    return bytes;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readChunkWithSignal(reader, signal);
      if (next.done) break;
      const value = next.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    // Whether we overflowed, errored, or the caller's abort fired, release the
    // connection instead of leaving a dangling read.
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Decode received bytes as UTF-8 (BOM stripped), matching Response.text(). */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}
