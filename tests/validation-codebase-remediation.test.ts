/**
 * Regression tests for Checkpoint C:
 * - F-04: Internal links resolve relative to containing file, reject escaping root
 * - F-06: Non-object package.json degrades gracefully with uncertainty note
 * - F-07: Distinct unittest vs pytest evidence
 * - F-08: Repository root cwd: "" preservation
 */
import { describe, it, expect } from "vitest";
import { validatePackage } from "../src/core/validate.js";
import {
  parseJsonObject,
  parsePackageJson,
  commandsFromPackageJson,
  testingEvidence,
  commandsFromCiWorkflows,
  buildRepositoryAnalysisFromFiles,
  type FetchedFile,
} from "../src/core/codebase/extract.js";
import type { CanonicalSkill } from "../src/core/types.js";
import { stringify as yamlStringify } from "yaml";

function makeMinimalSkill(files: { path: string; content: string }[]): CanonicalSkill {
  return {
    schemaVersion: "1",
    id: "link-test",
    plan: {
      whenToUse: [],
      inputs: [],
      steps: [],
      constraints: [],
      verification: [],
      pitfalls: [],
    },
    meta: {
      name: "link-test",
      displayName: "Link Test",
      description: "Testing link resolution",
      version: "1.0.0",
      generator: "test",
      generatedAt: new Date().toISOString(),
      gaps: [],
    },
    files: [
      {
        path: "SKILL.md",
        content: "---\nname: link-test\ndescription: Testing link resolution\n---\n\n# Link Test\n\n## Section\nContent",
        purpose: "instructions",
      },
      ...files.map((f) => ({ ...f, purpose: "test" })),
    ],
    provenance: [],
  };
}

describe("F-04: Internal markdown link resolution", () => {
  it("sibling link from references/a.md to references/b.md passes", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\nSee [B](b.md) for details." },
      { path: "references/b.md", content: "# B\n\nTarget file content." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("parent link ../SKILL.md from nested references/a.md passes", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\nReturn to [Skill](../SKILL.md)." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("package-root link from root SKILL.md passes", () => {
    const skill = makeMinimalSkill([
      { path: "references/guide.md", content: "# Guide\n\nDetailed guidance." },
    ]);
    const skillMd = skill.files.find((f) => f.path === "SKILL.md")!;
    skillMd.content += "\n\nSee [Guide](references/guide.md).";
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("root-relative link with leading slash passes when file exists", () => {
    const skill = makeMinimalSkill([
      { path: "references/guide.md", content: "# Guide\n\nDetailed guidance." },
      { path: "references/sub/topic.md", content: "# Topic\n\nSee [Guide](/references/guide.md)." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("path plus #fragment resolves to target file", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\nSee [Section](b.md#section-heading)." },
      { path: "references/b.md", content: "# B\n\nTarget file content." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("pure #fragment link is ignored", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\nJump to [Section](#local-section)." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("external URLs and mailto links are ignored", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\n[Web](https://example.com) and [Email](mailto:user@example.com)." },
    ]);
    const report = validatePackage({ skill });
    const linkFails = report.checks.filter((c) => c.id === "internal-links" && c.status === "fail");
    expect(linkFails).toHaveLength(0);
  });

  it("resolving to nonexistent nested path fails with actionable message", () => {
    const skill = makeMinimalSkill([
      // from inside references/a.md, referencing references/b.md looks for references/references/b.md
      { path: "references/a.md", content: "# A\n\nSee [B](references/b.md)." },
      { path: "references/b.md", content: "# B\n\nTarget file." },
    ]);
    const report = validatePackage({ skill });
    const failCheck = report.checks.find((c) => c.id === "internal-links" && c.status === "fail");
    expect(failCheck).toBeDefined();
    expect(failCheck?.message).toContain("Broken internal reference");
    expect(failCheck?.message).toContain('"references/b.md"');
  });

  it("escaping package root fails with explicit escape error", () => {
    const skill = makeMinimalSkill([
      { path: "references/a.md", content: "# A\n\n[Escaping](../../outside.md)." },
    ]);
    const report = validatePackage({ skill });
    const failCheck = report.checks.find((c) => c.id === "internal-links" && c.status === "fail");
    expect(failCheck).toBeDefined();
    expect(failCheck?.message).toContain("escapes the skill package root");
  });
});

describe("F-06: package.json non-object graceful degradation", () => {
  it("parseJsonObject handles valid objects and rejects non-objects", () => {
    expect(parseJsonObject('{"name": "test"}')).toEqual({ name: "test" });
    expect(parseJsonObject("null")).toBeNull();
    expect(parseJsonObject("[]")).toBeNull();
    expect(parseJsonObject('"string"')).toBeNull();
    expect(parseJsonObject("42")).toBeNull();
    expect(parseJsonObject("true")).toBeNull();
    expect(parseJsonObject("invalid json")).toBeNull();
  });

  it("parsePackageJson returns null for non-object JSON without throwing", () => {
    for (const invalid of ["null", "[]", '"string"', "42", "true", "{ broken:"]) {
      expect(parsePackageJson({ path: "package.json", content: invalid })).toBeNull();
    }
  });

  it("commandsFromPackageJson degrades gracefully and records malformedNotes for non-object package.json", () => {
    for (const invalid of ["null", "[]", '"string"', "42", "true"]) {
      const result = commandsFromPackageJson([
        { path: "package.json", content: invalid },
        { path: "src/index.ts", content: "console.log('hello');" },
      ]);
      expect(result.commands).toEqual([]);
      expect(result.frameworks).toEqual([]);
      expect(result.malformedNotes).toHaveLength(1);
      expect(result.malformedNotes[0]).toContain("package.json could not be parsed as a JSON object");
    }
  });

  it("buildRepositoryAnalysisFromFiles records uncertainty note and continues analysis when package.json is null", () => {
    const files: FetchedFile[] = [
      { path: "package.json", content: "null" },
      { path: "tests/test_calc.py", content: "import unittest\nclass Test(unittest.TestCase):\n    pass" },
    ];
    const analysis = buildRepositoryAnalysisFromFiles(
      {
        url: "https://github.com/acme/repo",
        owner: "acme",
        name: "repo",
        ref: "main",
        languages: [{ name: "Python", evidence: ["tests/test_calc.py"] }],
        ecosystems: ["python"],
        manifests: [{ path: "package.json", kind: "npm", fetched: true }],
        structure: { sourceRoots: [], testRoots: ["tests"], exampleRoots: [], packages: [] },
        entrypoints: [],
        importantFiles: [],
        instructions: [],
        ciWorkflows: [],
        fetched: files,
        selection: { treeBlobCount: 2, candidateCount: 2, selectedCount: 2, treeTruncated: false },
      },
      [],
    );
    expect(analysis.uncertainty.some((u) => u.includes("package.json could not be parsed as a JSON object"))).toBe(true);
    // Sibling test file was still analyzed successfully
    expect(analysis.testing.frameworks).toContain("unittest");
    expect(analysis.commands).toHaveLength(0);
  });
});

describe("F-07: Distinct unittest vs pytest evidence", () => {
  it("test file with unittest-only claims unittest and does NOT claim pytest", () => {
    const files: FetchedFile[] = [
      { path: "tests/test_sample.py", content: "import unittest\n\nclass TestSample(unittest.TestCase):\n    pass\n" },
    ];
    const result = testingEvidence(files, []);
    expect(result.frameworks).toContain("unittest");
    expect(result.frameworks).not.toContain("pytest");
  });

  it("from unittest import TestCase claims unittest and does NOT claim pytest", () => {
    const files: FetchedFile[] = [
      { path: "tests/test_sample.py", content: "from unittest import TestCase\n\nclass TestSample(TestCase):\n    pass\n" },
    ];
    const result = testingEvidence(files, []);
    expect(result.frameworks).toContain("unittest");
    expect(result.frameworks).not.toContain("pytest");
  });

  it("test file with pytest-only claims pytest and does NOT claim unittest", () => {
    const files: FetchedFile[] = [
      { path: "tests/test_sample.py", content: "import pytest\n\ndef test_add():\n    assert 1 + 1 == 2\n" },
    ];
    const result = testingEvidence(files, []);
    expect(result.frameworks).toContain("pytest");
    expect(result.frameworks).not.toContain("unittest");
  });

  it("test file with both unittest and pytest claims both", () => {
    const files: FetchedFile[] = [
      { path: "tests/test_sample.py", content: "import unittest\nimport pytest\n\nclass TestSample(unittest.TestCase):\n    pass\n" },
    ];
    const result = testingEvidence(files, []);
    expect(result.frameworks).toContain("unittest");
    expect(result.frameworks).toContain("pytest");
  });

  it("generic test file without framework imports does not fabricate pytest", () => {
    const files: FetchedFile[] = [
      { path: "tests/test_sample.py", content: "def test_something():\n    pass\n" },
    ];
    const result = testingEvidence(files, []);
    expect(result.frameworks).not.toContain("pytest");
    expect(result.frameworks).not.toContain("unittest");
    expect(result.relevantFiles).toContain("tests/test_sample.py");
  });
});

describe("F-08: Repository root cwd: '' preservation", () => {
  it("root CI step produces cwd: '' while subdirectory step produces concrete path", () => {
    const cmds = commandsFromCiWorkflows([
      {
        path: ".github/workflows/ci.yml",
        content: yamlStringify({
          name: "ci",
          on: "push",
          jobs: {
            build: {
              steps: [
                { run: "npm test" }, // root step -> cwd: ""
                { run: "npm run lint", "working-directory": "packages/lint" }, // subdirectory -> cwd: "packages/lint"
              ],
            },
          },
        }),
      },
    ]);
    const testCmd = cmds.find((c) => c.command === "npm test")!;
    expect(testCmd).toBeDefined();
    expect(testCmd.cwd).toBe("");
    expect(testCmd.evidence).toBe(".github/workflows/ci.yml (CI run step)");

    const lintCmd = cmds.find((c) => c.command === "npm run lint")!;
    expect(lintCmd).toBeDefined();
    expect(lintCmd.cwd).toBe("packages/lint");
    expect(lintCmd.evidence).toBe(".github/workflows/ci.yml (CI run step, working-directory: packages/lint)");
  });

  it("dynamic working-directory expression produces cwd: undefined", () => {
    const cmds = commandsFromCiWorkflows([
      {
        path: ".github/workflows/ci.yml",
        content: yamlStringify({
          name: "ci",
          on: "push",
          jobs: {
            build: {
              defaults: {
                run: { "working-directory": "${{ matrix.dir }}" },
              },
              steps: [{ run: "npm test" }],
            },
          },
        }),
      },
    ]);
    const testCmd = cmds.find((c) => c.command === "npm test")!;
    expect(testCmd).toBeDefined();
    expect(testCmd.cwd).toBeUndefined();
  });
});
