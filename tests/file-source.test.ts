import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFiles,
  combineFiles,
  resolveInsideRoot,
  FileSourceError,
  allowedRoot,
} from "../src/core/sources/files.js";

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
