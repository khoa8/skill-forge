import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, opendir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFiles,
  combineFiles,
  resolveInsideRoot,
  FileSourceError,
  allowedRoot,
  MAX_VISITED_ENTRIES, MAX_FILES, MAX_DEPTH, MAX_TOTAL_BYTES,
} from "../src/core/sources/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});
afterEach(() => { vi.mocked(opendir).mockReset(); });

let rootBackup: string | undefined;
let sandbox: string;

beforeAll(async () => {
  rootBackup = process.env.SKILLFORGE_DOCS_ROOT;
  sandbox = await mkdtemp(join(tmpdir(), "skillforge-files-"));
  process.env.SKILLFORGE_DOCS_ROOT = sandbox;
  await mkdir(join(sandbox, "docs", "sub"), { recursive: true });
  await writeFile(join(sandbox, "README.md"), "# Root readme\n\nContent of the root readme file.\n");
  await writeFile(join(sandbox, "docs", "guide.md"), "# Guide\n\nGuide content.\n");
  await writeFile(join(sandbox, "docs", "sub", "deep.md"), "# Deep\n\nDeep content.\n");
  await writeFile(join(sandbox, "docs", "notes.txt"), "Plain notes with plenty of text to read.\n");
  await writeFile(join(sandbox, "docs", "binary.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(sandbox, "docs", "huge.md"), "x".repeat(900_000));
});

afterAll(async () => {
  if (rootBackup === undefined) delete process.env.SKILLFORGE_DOCS_ROOT;
  else process.env.SKILLFORGE_DOCS_ROOT = rootBackup;
  await rm(sandbox, { recursive: true, force: true });
});

describe("resolveInsideRoot", () => {
  it("allows paths inside the root", async () => {
    const resolved = await resolveInsideRoot(sandbox, "docs/guide.md");
    expect(resolved.endsWith(join("docs", "guide.md"))).toBe(true);
    expect(resolved.startsWith((await realpath(sandbox)))).toBe(true);
  });

  it("refuses traversal outside the root", async () => {
    // An absolute path outside the root resolves and must be refused by the
    // containment check (not by missing-file).
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outsideDir, "outside.md"), "secret");
    const outsideReal = await realpath(join(outsideDir, "outside.md"));
    await expect(resolveInsideRoot(sandbox, outsideReal)).rejects.toMatchObject({
      code: "file_outside_root",
    });
    // A relative traversal to a nonexistent target must also fail closed.
    await expect(resolveInsideRoot(sandbox, "../outside.txt")).rejects.toThrow(FileSourceError);
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("refuses symlink escape", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-"));
    await writeFile(join(outsideDir, "secret.md"), "secret");
    await symlink(join(outsideDir, "secret.md"), join(sandbox, "docs", "sneaky.md"));
    await expect(collectFiles("docs/sneaky.md")).rejects.toMatchObject({ code: "file_outside_root" });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("reports missing paths", async () => {
    await expect(resolveInsideRoot(sandbox, "nope/missing.md")).rejects.toMatchObject({ code: "file_not_found" });
  });
});

describe("collectFiles", () => {
  it("reads a single supported file", async () => {
    const { files, skipped } = await collectFiles("docs/guide.md");
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toContain("Guide content");
    expect(skipped).toHaveLength(0);
  });

  it("rejects unsupported extensions", async () => {
    await expect(collectFiles("docs/binary.png")).rejects.toMatchObject({ code: "file_bad_extension" });
  });

  it("rejects oversized files", async () => {
    await expect(collectFiles("docs/huge.md")).rejects.toMatchObject({ code: "file_too_large" });
  });

  it("lists a directory non-recursively with honest skips", async () => {
    const { files, skipped } = await collectFiles("docs");
    const names = files.map((f) => f.path);
    expect(names).toContain("docs/guide.md");
    expect(names).toContain("docs/notes.txt");
    expect(names).not.toContain("docs/sub/deep.md");
    expect(names).not.toContain("docs/binary.png"); // silently filtered by extension
    expect(skipped.some((s) => s.includes("subdirectory"))).toBe(true);
  });

  it("walks recursively when asked, bounded", async () => {
    const { files } = await collectFiles("docs", { recursive: true });
    const names = files.map((f) => f.path);
    expect(names).toContain("docs/sub/deep.md");
    expect(names).toHaveLength(3); // guide.md, notes.txt, sub/deep.md
  });
});

describe("combineFiles", () => {
  it("joins multiple files with path headers", () => {
    const input = combineFiles([
      { path: "docs/a.md", content: "# A\n\nAlpha." },
      { path: "docs/b.md", content: "# B\n\nBeta." },
    ]);
    expect(input.type).toBe("file");
    expect(input.content).toContain("# docs/a.md");
    expect(input.content).toContain("# docs/b.md");
    expect(input.content).toContain("Beta.");
  });

  it("passes single files through unchanged", () => {
    const input = combineFiles([{ path: "README.md", content: "# Solo\n\nJust one." }]);
    expect(input.content).toBe("# Solo\n\nJust one.");
    expect(input.name).toBe("README.md");
  });
});

describe("allowedRoot", () => {
  it("defaults to the process cwd without the env var", () => {
    const prev = process.env.SKILLFORGE_DOCS_ROOT;
    delete process.env.SKILLFORGE_DOCS_ROOT;
    expect(allowedRoot()).toBe(process.cwd());
    process.env.SKILLFORGE_DOCS_ROOT = prev;
  });
});


describe("bounded deterministic traversal", () => {
  async function fixture(name: string, files: Record<string, string>) {
    const dir = join(sandbox, name);
    await mkdir(dir, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), content);
    }
    return dir;
  }
  function enumeration(reverse: boolean, onEntry: () => void = () => {}) {
    vi.mocked(opendir).mockImplementation(async (path) => {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      if (reverse) entries.reverse();
      return { async *[Symbol.asyncIterator]() { for (const entry of entries) { onEntry(); yield entry; } } } as unknown as Awaited<ReturnType<typeof opendir>>;
    });
  }
  it("sorts before file selection caps regardless of enumeration order", async () => {
    await fixture("ordered", Object.fromEntries(Array.from({ length: MAX_FILES + 3 }, (_, i) => [`f${String(i).padStart(2, "0")}.md`, "documented content"])));
    enumeration(false);
    const forward = await collectFiles("ordered");
    enumeration(true);
    const reverse = await collectFiles("ordered");
    expect(reverse).toEqual(forward);
    expect(forward.files).toHaveLength(MAX_FILES);
    expect(forward.files[0]!.path).toBe("ordered/f00.md");
    expect(forward.files.at(-1)!.path).toBe("ordered/f39.md");
    expect(forward.skipped).toContain(`stopped: file limit (${MAX_FILES}) reached`);
  });
  it("counts unsupported entries and directories, stops globally, and reports omitted listings", async () => {
    await fixture("budget", { "a.md": "retained documentation", "b/ignored1.bin": "x", "b/ignored2.bin": "x", "b/ignored3.bin": "x", "b/z.md": "not reached", "c/later.md": "not reached" });
    let visited = 0;
    enumeration(false, () => { visited++; });
    const result = await collectFiles("budget", { recursive: true, maxVisitedEntries: 5 });
    expect(visited).toBe(5); // three root entries, then two unsupported children
    expect(result.files.map((f) => f.path)).toEqual(["budget/a.md"]);
    expect(result.skipped.join("\n")).toContain("traversal entry limit (5) reached");
    expect(result.skipped.join("\n")).toContain("listing may be incomplete and was omitted");
    enumeration(true);
    expect(await collectFiles("budget", { recursive: true, maxVisitedEntries: 5 })).toEqual(result);
    await expect(collectFiles("budget", { maxVisitedEntries: 1 })).rejects.toThrow(/traversal entry limit/);
    await expect(collectFiles("budget", { maxVisitedEntries: MAX_VISITED_ENTRIES + 1 })).rejects.toMatchObject({ code: "file_bad_budget" });
  });
  it("retains byte, depth and symlink boundaries", async () => {
    await fixture("limits", { "a.md": "a".repeat(700_000), "b.md": "b".repeat(700_000), "c.md": "too much", ["deep/".repeat(MAX_DEPTH + 2) + "hidden.md"]: "not reached" });
    const capped = await collectFiles("limits", { recursive: true });
    expect(capped.files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0)).toBe(MAX_TOTAL_BYTES);
    expect(capped.skipped.join("\n")).toContain("total size limit");
    await fixture("depth", { "root.md": "safe", ["sub/".repeat(MAX_DEPTH + 2) + "hidden.md"]: "not reached" });
    await symlink(join(sandbox, "README.md"), join(sandbox, "depth", "link.md"));
    const depth = await collectFiles("depth", { recursive: true });
    expect(depth.files.map((f) => f.path)).toEqual(["depth/root.md"]);
    expect(depth.skipped.join("\n")).toContain("max depth");
    expect(depth.skipped.join("\n")).toContain("not a regular file");
  });
  it("aborts during enumeration and closes the iterator without reading files", async () => {
    const dir = await fixture("cancel-walk", { "a.md": "safe", "b.md": "safe" });
    const entries = await readdir(dir, { withFileTypes: true });
    const controller = new AbortController();
    let closed = false;
    let visited = 0;
    vi.mocked(opendir).mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {
        try { for (const entry of entries) { visited++; controller.abort(); yield entry; } }
        finally { closed = true; }
      },
    }) as unknown as Awaited<ReturnType<typeof opendir>>);
    await expect(collectFiles("cancel-walk", { signal: controller.signal })).rejects.toMatchObject({ code: "file_aborted" });
    expect(visited).toBe(1);
    expect(closed).toBe(true);
  });
});
