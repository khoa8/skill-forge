/** Bounded local PDF text-layer ingestion. No rendering, OCR or actions. */
import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { extname, relative, sep } from "node:path";
import { MAX_SOURCE_BYTES, MIN_SOURCE_CHARS } from "../ingest.js";
import type { SourceInput } from "../types.js";
import { allowedRoot, resolveInsideRoot, FileSourceError } from "./files.js";

export const MAX_PDF_BYTES = 10_000_000;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_TEXT_BYTES = MAX_SOURCE_BYTES;

export type PdfErrorCode =
  | "pdf_bad_path" | "pdf_not_found" | "pdf_outside_root" | "pdf_not_file"
  | "pdf_bad_extension" | "pdf_too_large" | "pdf_text_too_large"
  | "pdf_encrypted" | "pdf_no_text" | "pdf_invalid" | "pdf_parse_failed" | "pdf_aborted";

export class PdfSourceError extends Error {
  constructor(message: string, readonly code: PdfErrorCode) {
    super(message);
    this.name = "PdfSourceError";
  }
}

/** Narrow text-only seam: dependency types never leave this adapter. */
export interface PdfTextItem { str: string; hasEOL?: boolean }
export interface PdfPage {
  chunks: AsyncIterable<readonly PdfTextItem[]>;
  cleanup(): void;
}
export interface PdfDocument {
  numPages: number;
  encrypted(): Promise<boolean>;
  page(number: number): Promise<PdfPage>;
}
export interface PdfParserTask {
  document: Promise<PdfDocument>;
  destroy(): Promise<void>;
}
export type PdfParser = (bytes: Uint8Array) => PdfParserTask;

// Fail closed if a PDF requires an external font/CMap. No URL is supplied,
// and both main-thread resource factories and worker fetch are disabled.
class NoExternalResources {
  async fetch(): Promise<never> { throw new Error("External PDF resources are disabled."); }
}

async function loadParser(): Promise<PdfParser> {
  // Legacy ESM includes the JS compatibility helpers required on Node 20.
  // Its worker module lives in this production dependency, not in web/ or dist/.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return (bytes) => {
    const task = getDocument({
      data: bytes,
      verbosity: 0,
      isEvalSupported: false,
      enableXfa: false,
      useSystemFonts: false,
      disableFontFace: true,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      useWorkerFetch: false,
      CMapReaderFactory: NoExternalResources,
      StandardFontDataFactory: NoExternalResources,
      stopAtErrors: true,
    });
    return {
      destroy: () => task.destroy(),
      document: task.promise.then((doc): PdfDocument => ({
        numPages: doc.numPages,
        // Also rejects owner-encrypted PDFs that open without a password.
        encrypted: async () => {
          const { info } = await doc.getMetadata();
          return (info as { EncryptFilterName?: string | null }).EncryptFilterName != null;
        },
        page: async (number) => {
          const page = await doc.getPage(number);
          return {
            cleanup: () => { page.cleanup(); },
            chunks: (async function* () {
              // Do not rewrite Unicode compatibility characters or infer layout.
              const reader = page.streamTextContent({ disableNormalization: true }).getReader();
              let complete = false;
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) { complete = true; return; }
                  const items = value.items as Array<PdfTextItem | { type: string }>;
                  yield items.filter((item): item is PdfTextItem => "str" in item);
                }
              } finally {
                try { if (!complete) await reader.cancel(); }
                finally { reader.releaseLock(); }
              }
            })(),
          };
        },
      })),
    };
  };
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfSourceError("PDF ingestion was cancelled.", "pdf_aborted");
}

/** Pages are joined only with blank lines; no fabricated page headings. */
export async function readPdfSource(
  userPath: string,
  options: { signal?: AbortSignal; parse?: PdfParser } = {},
): Promise<{ input: SourceInput; notes: string[] }> {
  const { signal } = options;
  let task: PdfParserTask | undefined;
  let destruction: Promise<void> | undefined;
  // Observe rejection immediately on abort, but await cleanup in finally.
  const destroy = () => {
    if (task && !destruction) {
      destruction = Promise.resolve().then(() => task!.destroy());
      void destruction.catch(() => {});
    }
  };
  try {
    checkAbort(signal);
    if (!userPath.trim()) throw new PdfSourceError("Provide a PDF path under the allowed root.", "pdf_bad_path");
    const root = allowedRoot();
    let absolute: string;
    try { absolute = await resolveInsideRoot(root, userPath); }
    catch (err) {
      if (!(err instanceof FileSourceError)) throw err;
      const code = err.code === "file_bad_path" ? "pdf_bad_path"
        : err.code === "file_outside_root" ? "pdf_outside_root" : "pdf_not_found";
      // Never repeat an absolute caller path or a dependency exception.
      throw new PdfSourceError(code === "pdf_outside_root"
        ? "PDF path resolves outside the allowed documentation root (SKILLFORGE_DOCS_ROOT)."
        : code === "pdf_bad_path" ? "PDF path contains a null byte."
        : "PDF was not found within the allowed documentation root.", code);
    }
    checkAbort(signal);
    const info = await stat(absolute);
    if (!info.isFile()) throw new PdfSourceError("PDF source must be a regular file.", "pdf_not_file");
    if (extname(absolute).toLowerCase() !== ".pdf" || extname(userPath).toLowerCase() !== ".pdf") {
      throw new PdfSourceError("Choose a file with the .pdf extension.", "pdf_bad_extension");
    }
    if (info.size > MAX_PDF_BYTES) throw new PdfSourceError(`PDF exceeds ${MAX_PDF_BYTES} bytes. Use a smaller document.`, "pdf_too_large");
    const name = relative(await realpath(root), absolute).split(sep).join("/");
    checkAbort(signal);
    // Cap the read itself as well as stat: a concurrently growing file cannot
    // cause an unbounded read. O_NOFOLLOW also refuses a swapped final symlink.
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      if (!(await handle.stat()).isFile()) throw new PdfSourceError("PDF source must be a regular file.", "pdf_not_file");
      const stream = handle.createReadStream({ start: 0, end: MAX_PDF_BYTES, signal, autoClose: false });
      try {
        for await (const chunk of stream) {
          checkAbort(signal);
          size += chunk.length;
          if (size > MAX_PDF_BYTES) throw new PdfSourceError(`PDF exceeds ${MAX_PDF_BYTES} bytes. Use a smaller document.`, "pdf_too_large");
          chunks.push(chunk as Buffer);
        }
      } finally { stream.destroy(); }
    } finally { await handle.close(); }
    checkAbort(signal);
    const parse = options.parse ?? await loadParser();
    checkAbort(signal);
    task = parse(new Uint8Array(Buffer.concat(chunks, size)));
    signal?.addEventListener("abort", destroy, { once: true });
    const doc = await task.document;
    checkAbort(signal);
    if (await doc.encrypted()) throw new PdfSourceError("Encrypted PDFs are unsupported. Provide an unencrypted copy.", "pdf_encrypted");
    if (!Number.isSafeInteger(doc.numPages) || doc.numPages < 1) throw new PdfSourceError("PDF has an invalid page count.", "pdf_invalid");
    const pages: string[] = [];
    const blank: number[] = [];
    let bytes = 0;
    let processed = 0;
    let stoppedAt: number | undefined;
    const pageLimit = Math.min(doc.numPages, MAX_PDF_PAGES);
    for (let number = 1; number <= pageLimit; number++) {
      checkAbort(signal);
      const page = await doc.page(number);
      let text = "";
      let pageBytes = 0;
      let tooLarge = false;
      try {
        for await (const items of page.chunks) {
          checkAbort(signal);
          for (const item of items) {
            // Keep parser order/EOL. Between non-whitespace fragments insert
            // one space, never geometric sorting, heading or table inference.
            const space = text && item.str && !/\s$/.test(text) && !/^\s/.test(item.str) ? " " : "";
            const part = space + item.str + (item.hasEOL ? "\n" : "");
            pageBytes += Buffer.byteLength(part, "utf8");
            if (bytes + (pages.length ? 2 : 0) + pageBytes > MAX_PDF_TEXT_BYTES) { tooLarge = true; break; }
            text += part;
          }
          if (tooLarge) break;
        }
      } finally { page.cleanup(); }
      checkAbort(signal);
      if (tooLarge) {
        if (pages.join("\n\n").trim().length < MIN_SOURCE_CHARS) {
          throw new PdfSourceError("The first usable PDF text cannot fit the source byte limit. Split the document into smaller pages.", "pdf_text_too_large");
        }
        stoppedAt = number;
        break;
      }
      processed++;
      text = text.trim();
      if (!text) blank.push(number);
      else {
        bytes += Buffer.byteLength(text, "utf8") + (pages.length ? 2 : 0);
        pages.push(text);
      }
    }
    const content = pages.join("\n\n");
    if (content.trim().length < MIN_SOURCE_CHARS) {
      throw new PdfSourceError("No usable PDF text layer was found. OCR is not supported; use a text-based PDF or paste extracted text (at least 40 characters).", "pdf_no_text");
    }
    const notes = [`Processed ${processed} of ${doc.numPages} PDF page(s) from ${name}. Text layer only; no OCR or layout reconstruction.`];
    if (doc.numPages > MAX_PDF_PAGES) notes.push(`PDF page limit: only the first ${MAX_PDF_PAGES} pages were eligible; ${doc.numPages - MAX_PDF_PAGES} later page(s) were omitted.`);
    if (stoppedAt) notes.push(`Text byte limit: stopped before page ${stoppedAt}; ${doc.numPages - processed} page(s) were omitted from the source.`);
    if (blank.length) notes.push(`${blank.length} processed page(s) had no extractable text: ${blank.slice(0, 12).join(", ")}${blank.length > 12 ? `; and ${blank.length - 12} more` : ""}.`);
    checkAbort(signal);
    return { input: { type: "pdf", name, content, notes }, notes };
  } catch (err) {
    checkAbort(signal);
    if (err instanceof PdfSourceError) throw err;
    if (err instanceof Error && err.name === "PasswordException") {
      throw new PdfSourceError("Encrypted PDFs are unsupported. Provide an unencrypted copy.", "pdf_encrypted");
    }
    if (err instanceof Error && ["InvalidPDFException", "FormatError", "UnknownErrorException"].includes(err.name)) {
      throw new PdfSourceError("PDF is malformed or unsupported. Provide a valid text-based PDF.", "pdf_invalid");
    }
    throw new PdfSourceError("PDF could not be read or its text extracted. Check access and provide a valid text-based PDF.", "pdf_parse_failed");
  } finally {
    signal?.removeEventListener("abort", destroy);
    destroy();
    try { await destruction; }
    catch { throw new PdfSourceError("PDF resource cleanup failed.", "pdf_parse_failed"); }
    checkAbort(signal);
  }
}
