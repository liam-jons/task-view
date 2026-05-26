import { describe, expect, test } from "bun:test";
import {
  formatTopLevelHelp,
  formatVersion,
  isTopLevelHelpInvocation,
  isVersionInvocation,
} from "./cli";
// The canonical tool version lives in the ROOT package.json (`0.2.0` at
// time of writing). Import it so the assertion tracks future version
// bumps instead of rotting on a hardcoded literal.
import rootPkg from "../../package.json";

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

  test("formats version string from the canonical root package.json", () => {
    const output = formatVersion();
    // Shape: `task-view <semver>` — never the rotting `dev`/`0.1.0` literals.
    expect(output).toMatch(/^task-view \d+\.\d+\.\d+/);
    // And it must equal the REAL tool version from the root package.json.
    expect(output).toBe(`task-view ${rootPkg.version}`);
  });
});
