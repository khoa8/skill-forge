import { describe, expect, it } from "vitest";
import { neutralizeRelativeLinks } from "../src/core/build.js";

describe("neutralizeRelativeLinks (regression: multi-line label)", () => {
  it("neutralizes relative links, including multi-line labels", () => {
    const input = "[Contribution\nguidelines for this project](docs/CONTRIBUTING.md)";
    const out = neutralizeRelativeLinks(input);
    expect(out).not.toContain("](docs/CONTRIBUTING.md)");
    expect(out).toContain("Contribution guidelines for this project");
    expect(out).toContain("`docs/CONTRIBUTING.md`");
  });

  it("leaves absolute URLs, anchors, and root-relative targets untouched", () => {
    const input = "[a](https://x.com/y) [b](#anchor) [c](/root/path)";
    expect(neutralizeRelativeLinks(input)).toBe(input);
  });

  it("leaves plain text and images without links unchanged", () => {
    expect(neutralizeRelativeLinks("no links here")).toBe("no links here");
  });
});
