// SBS-897: the macOS branch of scripts/install.sh has no test harness of its
// own. install.Tests.bash shims `uname` as Linux and drives the AppImage path;
// hdiutil, codesign and /Applications are not reachable from it, and CI has no
// macOS installer job. So the guarantees this branch makes are pinned here as
// source assertions, the same way linux-deb-command.test.ts pins the .deb path.
//
// Both are guarantees that fail SILENTLY if they regress: a signature check that
// stops checking who signed still prints "Verifying the app signature", and a
// swap that deletes before it renames still installs fine every time nothing
// goes wrong.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const installShPath = join(process.cwd(), "scripts", "install.sh");
const script = readFileSync(installShPath, "utf8");

function macosBranch(): string {
  const start = script.indexOf("install_macos() {");
  expect(start, "install.sh is missing install_macos").toBeGreaterThan(-1);
  const after = script.slice(start);
  const end = after.indexOf("\n}\n");
  expect(end, "could not find the end of install_macos").toBeGreaterThan(-1);
  return after.slice(0, end);
}

describe("install.sh macOS path (SBS-897)", () => {
  const branch = macosBranch();

  it("verifies the signature before touching /Applications", () => {
    const verifyAt = branch.indexOf("codesign --verify");
    // The first write into /Applications, not the cleanup trap that names the
    // same path.
    const stageAt = branch.indexOf('cp -R "$app" "$staged"');
    expect(verifyAt, "no codesign --verify in install_macos").toBeGreaterThan(-1);
    expect(stageAt, "no staged copy in install_macos").toBeGreaterThan(-1);
    expect(
      verifyAt,
      "the signature is checked after the bundle is already staged in /Applications",
    ).toBeLessThan(stageAt);
  });

  it("pins the signing team, because a valid signature is not enough", () => {
    // codesign --verify only proves the bundle satisfies its own embedded
    // requirement, so an attacker who re-signs a tampered build with their own
    // Developer ID passes it. The team id is what ties the bundle to us.
    expect(script).toContain('EXPECTED_TEAM_ID="V4YZPC7T6G"');
    expect(branch).toContain("TeamIdentifier=");
    expect(branch).toMatch(/\[ "\$signing_team" != "\$EXPECTED_TEAM_ID" \]/);
  });

  it("never removes the live bundle before the replacement is in place", () => {
    // The failure this prevents: rm succeeds, the following mv fails, and the
    // machine is left with no Toolport at all.
    expect(
      branch,
      "install_macos deletes /Applications/Toolport.app instead of moving it aside",
    ).not.toMatch(/rm -rf "\/Applications\/Toolport\.app"/);
    expect(branch).toContain('mv "/Applications/Toolport.app" "$previous"');
    expect(branch).toContain('mv "$staged" "/Applications/Toolport.app"');
  });

  it("restores the previous install when the final rename fails", () => {
    const renameAt = branch.indexOf('if ! mv "$staged" "/Applications/Toolport.app"');
    expect(renameAt).toBeGreaterThan(-1);
    const failureBlock = branch.slice(renameAt, renameAt + 400);
    expect(failureBlock).toContain('mv "$previous" "/Applications/Toolport.app"');
  });

  it("always detaches the disk image, including on an error exit", () => {
    // Every err in this branch is an exit, so the trap is what makes "the image
    // is never left mounted" true for the paths that forget.
    expect(branch).toMatch(/trap '.*hdiutil detach.*' EXIT/);
  });
});
