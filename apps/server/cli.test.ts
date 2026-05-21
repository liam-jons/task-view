import { describe, expect, test } from "bun:test";
import {
  formatTopLevelHelp,
  formatVersion,
  isTopLevelHelpInvocation,
  isVersionInvocation,
} from "./cli";

describe("CLI top-level help", () => {
  test("recognizes top-level --help", () => {
    expect(isTopLevelHelpInvocation(["--help"])).toBe(true);
    expect(isTopLevelHelpInvocation([])).toBe(false);
    expect(isTopLevelHelpInvocation(["review", "--help"])).toBe(false);
  });

  test("renders task-view top-level usage", () => {
    const output = formatTopLevelHelp();

    expect(output).toContain("task-view");
    expect(output).toContain("--no-browser");
    expect(output).toContain("--port");
    expect(output).toContain("--check");
  });
});

describe("CLI --version", () => {
  test("recognizes --version and -v", () => {
    expect(isVersionInvocation(["--version"])).toBe(true);
    expect(isVersionInvocation(["-v"])).toBe(true);
    expect(isVersionInvocation([])).toBe(false);
    expect(isVersionInvocation(["review"])).toBe(false);
  });

  test("formats version string", () => {
    const output = formatVersion();
    expect(output).toStartWith("task-view ");
  });
});
