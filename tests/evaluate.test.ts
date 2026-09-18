import { describe, expect, it } from "vitest";
import { normalizeSource } from "../src/core/ingest.js";
import { analyzeSource } from "../src/core/analyze.js";
import { buildCanonicalSkill, derivePlanFromAnalysis, manifestFor } from "../src/core/build.js";
import { evaluateSkill } from "../src/core/evaluate.js";
import { validatePackage } from "../src/core/validate.js";

function fixture() {
  const source = normalizeSource({
    type: "text",
    name: "guide",
    content: "# Guide\n\nDocumentation for a deterministic local workflow.\n\n## Setup\n\nRead the configuration before proceeding with this operation.\n\n1. Read the configuration.\n2. Select the documented option.\n3. Verify the result.\n",
  });
  const analysis = analyzeSource(source);
  const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
  return { skill, source };
}

function syncManifest(ctx: ReturnType<typeof fixture>) {
  ctx.skill.files.find((file) => file.path === "manifest.json")!.content = manifestFor(
    ctx.skill.files.filter((file) => file.path !== "manifest.json"),
    ctx.skill.meta,
    { name: ctx.source.originalName, sha256: ctx.source.sha256, lineCount: ctx.source.lineCount, notes: ctx.source.notes },
  );
}

describe("evaluateSkill", () => {
  it("does not pass an eval whose prompt was changed", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items[0].prompt = "Does the skill mention anything at all?";
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.checks.find((check) => check.id === specification.items[0].id)?.status).toBe("not-executable");
    expect(report.counts.notExecutable).toBeGreaterThan(0);
  });

  it("reports a deleted expected eval explicitly instead of dropping it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    const [removed] = specification.items.splice(1, 1);
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const check = report.checks.find((c) => c.id === removed.id);
    expect(check?.status).toBe("not-executable");
    expect(check?.message).toMatch(/missing/i);
  });

  it("reports explicit outcomes when items is empty but the source implies expectations (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    file.content = JSON.stringify({ schema: "skillforge.evals/1", items: [] });
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.concern).toBe(0);
    expect(report.counts.notExecutable).toBe(report.checks.length);
  });

  it("surfaces a schema-invalid expected item instead of dropping it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items[0].assertions[0].type = "bogus-kind";
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const check = report.checks.find((c) => c.id === specification.items[0].id);
    expect(check?.status).toBe("not-executable");
    expect(check?.message).toMatch(/malformed|not-executable|parse/i);
  });

  it("surfaces a duplicated expected id instead of evaluating it twice (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    specification.items.push(structuredClone(specification.items[0]));
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    const matches = report.checks.filter((c) => c.id === specification.items[0].id);
    expect(matches.length).toBe(1);
    expect(matches[0]?.status).toBe("not-executable");
    expect(matches[0]?.message).toMatch(/duplicate/i);
  });

  it("fails an over-limit eval inventory honestly instead of truncating it (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    for (let i = 0; i < 64; i++) {
      specification.items.push({
        id: `eval-pad-${i}`,
        kind: "grounding",
        prompt: `Padding manual question ${i}?`,
        expect: "Padding expectation for bound testing.",
      });
    }
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.executed).toBe(false);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.concern).toBe(0);
    expect(report.checks.some((c) => c.status === "not-executable" && /at most 64/i.test(c.message))).toBe(true);
  });

  it("keeps legacy manual-only items as not-executable, never passes (F-01)", () => {
    const ctx = fixture();
    const file = ctx.skill.files.find((file) => file.path === "evals/evals.json")!;
    const specification = JSON.parse(file.content);
    for (const item of specification.items) delete item.assertions;
    file.content = JSON.stringify(specification);
    syncManifest(ctx);
    const report = evaluateSkill(ctx);
    expect(report.executed).toBe(true);
    expect(report.counts.passed).toBe(0);
    expect(report.counts.notExecutable).toBe(report.checks.length);
  });

  it("does not penalize canonical relative-link neutralization in topics or steps (F-02)", () => {
    const source = normalizeSource({
      type: "text",
      name: "guide",
      content: "# Guide\n\nDocumentation for a deterministic local workflow.\n\n## Setup\n\nRead [the configuration guide](docs/config.md) before continuing with this documented operation.\n\n1. Read [the configuration guide](docs/config.md) first.\n2. Select the documented option next.\n3. Verify the operation result afterwards.\n",
    });
    const analysis = analyzeSource(source);
    const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
    const report = evaluateSkill({ skill, source });
    expect(report.executed).toBe(true);
    expect(report.counts.concern).toBe(0);
    expect(report.checks.filter((c) => c.status === "pass").length).toBeGreaterThan(0);
  });

  it("reports an oversized procedure step as not-executable, not a concern (F-02 bounds)", () => {
    const longStep = `Migrate the legacy datastore by exporting every record (${"detail ".repeat(620).trim()}) and confirm the export checksum.`;
    const source = normalizeSource({
      type: "text",
      name: "guide",
      content: `# Guide\n\nDocumentation for a deterministic local workflow.\n\n## Setup\n\nRead the configuration before proceeding with this operation.\n\n1. Read the configuration.\n2. ${longStep}\n3. Verify the result.\n`,
    });
    expect(longStep.length).toBeGreaterThan(4000);
    const analysis = analyzeSource(source);
    expect(analysis.procedures).toHaveLength(1);
    expect(analysis.procedures[0]!.steps).toHaveLength(3);
    const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
    const validation = validatePackage({ skill, sourceText: source.text, sourceType: source.sourceType });
    expect(validation.passed).toBe(true);
    const report = evaluateSkill({ skill, source });
    expect(report.executed).toBe(true);
    const procedure = report.checks.find((c) => c.id === "eval-2");
    expect(procedure?.status).toBe("not-executable");
    expect(procedure?.message).toMatch(/comparison window|at most 4000/i);
    expect(report.counts.concern).toBe(0);
  });

  it("treats a healthy non-Latin topic as discoverable via its SKILL.md link (A-01a)", () => {
    const source = normalizeSource({
      type: "text",
      name: "japanese-guide",
      content: [
        "# 利用ガイド",
        "",
        "このドキュメントは、決定論的なローカル作業手順に関する説明資料です。",
        "",
        "## 設定手順",
        "",
        "操作を続行する前に構成内容をお読みください。この手順に関する文書化された指針に従って作業を進めてください。設定値を確認してから次の段階に進みます。",
        "",
        "1. 構成ファイルを開きます。",
        "2. 文書化された選択肢の中から適切なものを選びます。",
        "3. 操作の結果を検証して記録します。",
        "",
        "## 障害対応",
        "",
        "問題が発生した場合の対処方法を説明します。よくある失敗とその回避策を以下にまとめています。追加の情報が必要な場合は管理者に問い合わせてください。",
        "",
        "- 設定が見つからない場合は探索対象の経路を確認します。",
        "- 権限不足の通知が出た場合は管理者に問い合わせます。",
        "",
      ].join("\n"),
    });
    const analysis = analyzeSource(source);
    const skill = buildCanonicalSkill(source, analysis, derivePlanFromAnalysis(analysis), "mock");
    expect(validatePackage({ skill, sourceText: source.text, sourceType: source.sourceType }).passed).toBe(true);
    const report = evaluateSkill({ skill, source });
    expect(report.executed).toBe(true);
    const topics = report.checks.filter((check) => check.filePath?.startsWith("references/"));
    expect(topics.length).toBeGreaterThan(0);
    for (const topic of topics) {
      expect(topic.status).toBe("pass");
    }
    expect(report.counts.concern).toBe(0);
  });

  it("reports concern when the SKILL.md link is removed but generic vocabulary remains (A-01b)", () => {
    const ctx = fixture();
    const target = ctx.skill.files.find((file) => file.path.startsWith("references/"))!.path;
    const skillMd = ctx.skill.files.find((file) => file.path === "SKILL.md")!;
    // Remove the explicit discoverability relationship: every Markdown link
    // and every bare-path mention of the target goes away, while generic
    // source vocabulary ("documented", "configuration", "operation") stays.
    skillMd.content = skillMd.content
      .split("\n")
      .map((line) =>
        /^\s*-\s*\[[^\]]+\]\((references\/[^)]+)\)/.test(line)
          ? "- See the documented guidance for configuration and operation details."
          : line,
      )
      .join("\n")
      .split(target)
      .join("the documented configuration guidance");
    syncManifest(ctx);
    // The mutated structure is still a shippable package: the reference and
    // its excerpt are intact, so validation keeps passing.
    expect(validatePackage({ skill: ctx.skill, sourceText: ctx.source.text, sourceType: ctx.source.sourceType }).passed).toBe(true);
    const report = evaluateSkill(ctx);
    expect(report.executed).toBe(true);
    const topic = report.checks.find((check) => check.filePath === target);
    expect(topic?.status).toBe("concern");
    expect(topic?.message).toMatch(/no Markdown link|not discoverable/i);
  });

  describe("topic discoverability link semantics (F-01)", () => {
    function topicCase(replacementFor: (target: string) => string) {
      const ctx = fixture();
      const target = ctx.skill.files.find((file) => file.path.startsWith("references/"))!.path;
      const linkLine = new RegExp(`^\\s*-\\s*\\[[^\\]]+\\]\\(${target.replace("/", "\\/")}\\)[^\\n]*$`);
      const skillMd = ctx.skill.files.find((file) => file.path === "SKILL.md")!;
      skillMd.content = skillMd.content
        .split("\n")
        .map((line) => (linkLine.test(line) ? "@@CASE@@" : line))
        .join("\n")
        .split(target)
        .join("the documented configuration guidance")
        .split("@@CASE@@")
        .join(replacementFor(target));
      syncManifest(ctx);
      return { skill: ctx.skill, source: ctx.source, target };
    }

    it.each([
      ["builder link", (target: string) => `- [${target}](${target}) — "Setup" (source lines 5–11)`],
      ["titled link", (target: string) => `[Setup](${target} "Setup documentation")`],
      ["fragment link", (target: string) => `[Setup](${target}#setup-details)`],
    ])("treats %s as an explicit discoverability link", (_name, render) => {
      const { skill, source, target } = topicCase(render);
      expect(validatePackage({ skill, sourceText: source.text, sourceType: source.sourceType }).passed).toBe(true);
      const report = evaluateSkill({ skill, source });
      expect(report.executed).toBe(true);
      expect(report.checks.find((check) => check.filePath === target)?.status).toBe("pass");
    });

    it.each([
      ["image", (target: string) => `![Setup diagram](${target})`],
      ["fenced code block", (target: string) => `\`\`\`md\n[Example only](${target})\n\`\`\``],
      ["inline code span", (target: string) => `\`[x](${target})\``],
      ["escaped text", (target: string) => `\\[x](${target})`],
      ["HTML comment", (target: string) => `<!-- [old reference](${target}) -->\n\nSee the documented configuration guidance for details.`],
    ])("does not treat %s as an explicit discoverability link", (_name, render) => {
      const { skill, source, target } = topicCase(render);
      expect(validatePackage({ skill, sourceText: source.text, sourceType: source.sourceType }).passed).toBe(true);
      const report = evaluateSkill({ skill, source });
      expect(report.executed).toBe(true);
      const topic = report.checks.find((check) => check.filePath === target);
      expect(topic?.status).toBe("concern");
      expect(topic?.message).toMatch(/no Markdown link|not discoverable/i);
    });
  });
});
