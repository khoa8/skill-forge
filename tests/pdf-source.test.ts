import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPdfSource, MAX_PDF_BYTES, MAX_PDF_PAGES, MAX_PDF_TEXT_BYTES, type PdfParser, type PdfTextItem } from "../src/core/sources/pdf.js";
import { normalizeSource } from "../src/core/ingest.js";
import { collectFiles } from "../src/core/sources/files.js";
import { PDF_GUIDE, pdfFixture } from "./helpers/pdf-fixture.js";

function parser(pages: PdfTextItem[][], encrypted = false) {
  const cleanup = vi.fn();
  const destroy = vi.fn(async () => {});
  const page = vi.fn(async (n: number) => ({
    cleanup,
    chunks: (async function* () { yield pages[n - 1]!; })(),
  }));
  const parse: PdfParser = () => ({ document: Promise.resolve({ numPages: pages.length, encrypted: async () => encrypted, page }), destroy });
  return { parse, page, destroy, cleanup };
}
const useful = [{ str: PDF_GUIDE.join("\n") }];

describe("bounded local PDF source", () => {
  let sandbox: string;
  let root: string;
  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "skillforge-pdf-"));
    root = join(sandbox, "docs");
    await mkdir(root);
    vi.stubEnv("SKILLFORGE_DOCS_ROOT", root);
    await writeFile(join(root, "guide.pdf"), pdfFixture());
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(sandbox, { recursive: true, force: true }); });

  it("extracts real text in page order with stable literal provenance and inert actions", async () => {
    await writeFile(join(root, "guide.pdf"), pdfFixture([PDF_GUIDE, [], ["Second page contains additional instructions for the widget client.", "https://example.invalid/document"]], true));
    const fetch = vi.fn(() => { throw new Error("Network forbidden"); });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("pdfExecuted", false);
    const first = await readPdfSource("guide.pdf");
    expect(first).toEqual(await readPdfSource("guide.pdf"));
    expect(first.input.type).toBe("pdf");
    expect(first.input.name).toBe("guide.pdf");
    expect(first.input.content.indexOf("Widget API Guide")).toBeLessThan(first.input.content.indexOf("Second page"));
    expect(first.notes.join(" ")).toContain("no extractable text: 2");
    expect(first.notes.join(" ")).not.toContain(sandbox);
    const normalized = normalizeSource(first.input);
    expect(normalized.text).toContain('<div class="example">Literal markup &amp; stays text.</div>');
    expect(normalizeSource({ ...first.input, content: normalized.text })).toEqual(normalized);
    expect(fetch).not.toHaveBeenCalled();
    expect((globalThis as { pdfExecuted?: boolean }).pdfExecuted).toBe(false);
    await expect(collectFiles("guide.pdf")).rejects.toMatchObject({ code: "file_bad_extension" });
  });

  it("rejects outside, traversal, symlink, null-byte, directory and non-PDF paths safely", async () => {
    await writeFile(join(sandbox, "outside.pdf"), pdfFixture());
    await symlink(join(sandbox, "outside.pdf"), join(root, "escape.pdf"));
    await mkdir(join(root, "directory.pdf"));
    await writeFile(join(root, "text.txt"), pdfFixture());
    for (const [path, code] of [
      [join(sandbox, "outside.pdf"), "pdf_outside_root"], ["../outside.pdf", "pdf_outside_root"],
      ["escape.pdf", "pdf_outside_root"], ["bad\0.pdf", "pdf_bad_path"],
      ["directory.pdf", "pdf_not_file"], ["text.txt", "pdf_bad_extension"], ["missing.pdf", "pdf_not_found"],
    ]) {
      await expect(readPdfSource(path!)).rejects.toMatchObject({ code, message: expect.not.stringContaining(sandbox) });
    }
    await writeFile(join(root, "UPPER.PDF"), pdfFixture());
    expect((await readPdfSource(join(root, "UPPER.PDF"))).input.name).toBe("UPPER.PDF");
  });

  it("rejects an oversized sparse binary before parsing", async () => {
    const file = await open(join(root, "big.pdf"), "w");
    await file.truncate(MAX_PDF_BYTES + 1);
    await file.close();
    const parse = vi.fn<PdfParser>();
    await expect(readPdfSource("big.pdf", { parse })).rejects.toMatchObject({ code: "pdf_too_large" });
    expect(parse).not.toHaveBeenCalled();
  });

  it("processes exactly the bounded prefix and reports all omitted pages", async () => {
    const p = parser(Array.from({ length: 10_000 }, (_, i) => [{ str: `Page ${i + 1} contains useful documentation for widget configuration.` }]));
    const result = await readPdfSource("guide.pdf", p);
    expect(p.page).toHaveBeenCalledTimes(MAX_PDF_PAGES);
    expect(result.notes.join(" ")).toContain("9800 later page(s) were omitted");
    expect(result.input.content).not.toContain("Page 201 ");
    expect(p.destroy).toHaveBeenCalledOnce();
    expect(p.cleanup).toHaveBeenCalledTimes(MAX_PDF_PAGES);
  });

  it("bounds UTF-8 text on whole-page boundaries, cancelling an oversized page stream", async () => {
    const p = parser([useful, [{ str: "漢".repeat(Math.floor(MAX_PDF_TEXT_BYTES / 3)) }], useful]);
    const result = await readPdfSource("guide.pdf", p);
    expect(result.input.content).toBe(PDF_GUIDE.join("\n"));
    expect(Buffer.byteLength(result.input.content)).toBeLessThanOrEqual(MAX_PDF_TEXT_BYTES);
    expect(result.notes.join(" ")).toContain("stopped before page 2; 2 page(s) were omitted");
    expect(p.page).toHaveBeenCalledTimes(2);
    expect(p.cleanup).toHaveBeenCalledTimes(2);
    expect(p.destroy).toHaveBeenCalledOnce();
    const firstHuge = parser([[{ str: "漢".repeat(MAX_PDF_TEXT_BYTES / 3 + 1) }]]);
    await expect(readPdfSource("guide.pdf", firstHuge)).rejects.toMatchObject({ code: "pdf_text_too_large" });
    expect(firstHuge.destroy).toHaveBeenCalledOnce();
  });

  it("preserves Unicode, item spacing and reported EOL without guessing headings", async () => {
    const p = parser([[{ str: "Literal ﬀ Ａ Ω" }, { str: "text", hasEOL: true }, { str: "<tag>&amp;</tag>" }, { str: " with supplied spaces." }]]);
    const result = await readPdfSource("guide.pdf", p);
    expect(result.input.content).toBe("Literal ﬀ Ａ Ω text\n<tag>&amp;</tag> with supplied spaces.");
  });

  it("rejects real blank, short and malformed PDFs with safe typed errors", async () => {
    for (const [bytes, code] of [[pdfFixture([[]]), "pdf_no_text"], [pdfFixture([["tiny watermark"]]), "pdf_no_text"], [Buffer.from("not a PDF"), "pdf_invalid"]] as const) {
      await writeFile(join(root, "bad.pdf"), bytes);
      await expect(readPdfSource("bad.pdf")).rejects.toMatchObject({ code, message: expect.not.stringContaining(root) });
    }
  });

  it("rejects encrypted documents and password failures while always destroying resources", async () => {
    const p = parser([useful], true);
    await expect(readPdfSource("guide.pdf", p)).rejects.toMatchObject({ code: "pdf_encrypted" });
    expect(p.page).not.toHaveBeenCalled();
    expect(p.destroy).toHaveBeenCalledOnce();
    for (const [name, code] of [["PasswordException", "pdf_encrypted"], ["Error", "pdf_parse_failed"]]) {
      const destroy = vi.fn(async () => {});
      const parse: PdfParser = () => ({ document: Promise.reject(Object.assign(new Error(`${root}: private data`), { name })), destroy });
      await expect(readPdfSource("guide.pdf", { parse })).rejects.toMatchObject({ code, message: expect.not.stringContaining(root) });
      expect(destroy).toHaveBeenCalledOnce();
    }
  });

  it("honors pre-abort and destroys extraction at a deterministic chunk boundary", async () => {
    const controller = new AbortController();
    const p = parser([useful]);
    controller.abort();
    await expect(readPdfSource("guide.pdf", { ...p, signal: controller.signal })).rejects.toMatchObject({ code: "pdf_aborted" });
    expect(p.page).not.toHaveBeenCalled();
    const active = new AbortController();
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => {});
    const page = vi.fn(async () => ({ cleanup, chunks: (async function* () { yield useful; active.abort(); yield useful; })() }));
    const parse: PdfParser = () => ({ document: Promise.resolve({ numPages: 2, encrypted: async () => false, page }), destroy });
    await expect(readPdfSource("guide.pdf", { parse, signal: active.signal })).rejects.toMatchObject({ code: "pdf_aborted" });
    expect(page).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
