import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { GitService } from "../src/git";

const fixtureRoot = fs.mkdtempSync(
  path.join(process.cwd(), ".git-diff-viewer-test-"),
);
const nestedWorkspaceRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "git-diff-viewer-nested-"),
);
const git = new GitService();

after(() => {
  const resolved = path.resolve(fixtureRoot);
  if (resolved.startsWith(path.resolve(process.cwd()))) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
  fs.rmSync(nestedWorkspaceRoot, { recursive: true, force: true });
});

function runGit(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: fixtureRoot,
    encoding: "utf8",
    windowsHide: true,
  });
}

function write(relativePath: string, content: string): void {
  const fullPath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function commit(message: string): void {
  runGit("add", "-A");
  runGit(
    "-c",
    "user.name=Diff Viewer Test",
    "-c",
    "user.email=diff-viewer@example.com",
    "commit",
    "-qm",
    message,
  );
}

test("GitService discovers the repository and reads working changes", async () => {
  runGit("init", "-q");
  write(".gitignore", "ignored.log\n");
  write("ignored.log", "ignored\n");
  write("src/a.ts", "one\n");
  write("old.ts", "old\n");
  write("removed.ts", "gone\n");
  commit("initial");

  write("src/a.ts", "two\n");
  write("new.ts", "new\n");
  runGit("mv", "old.ts", "renamed.ts");
  fs.unlinkSync(path.join(fixtureRoot, "removed.ts"));

  const repositories = await git.discoverRepositories([fixtureRoot]);
  assert.equal(repositories.length, 1);
  assert.equal(repositories[0].root, path.resolve(fixtureRoot));

  const changes = await git.getChanges(repositories[0].root, {
    mode: "working",
    baseRef: "HEAD",
  });
  const byPath = new Map(changes.map((change) => [change.path, change]));

  assert.equal(byPath.get("src/a.ts")?.status, "M");
  assert.equal(byPath.get("new.ts")?.status, "A");
  assert.equal(byPath.get("renamed.ts")?.status, "R");
  assert.equal(byPath.get("renamed.ts")?.oldPath, "old.ts");
  assert.equal(byPath.get("removed.ts")?.status, "D");

  const allFiles = await git.getAllFiles(repositories[0].root, {
    mode: "working",
    baseRef: "HEAD",
  });
  assert.ok(allFiles.includes("src/a.ts"));
  assert.ok(allFiles.includes("new.ts"));
  assert.ok(allFiles.includes("renamed.ts"));
  assert.ok(!allFiles.includes("ignored.log"));
});

test("GitService compares two versions and reads historical content", async () => {
  commit("second");

  const changes = await git.getChanges(fixtureRoot, {
    mode: "refs",
    baseRef: "HEAD~1",
    targetRef: "HEAD",
  });
  const byPath = new Map(changes.map((change) => [change.path, change]));

  assert.equal(byPath.get("src/a.ts")?.status, "M");
  assert.equal(byPath.get("new.ts")?.status, "A");
  assert.equal(byPath.get("renamed.ts")?.status, "R");
  assert.equal(byPath.get("removed.ts")?.status, "D");

  const allFiles = await git.getAllFiles(fixtureRoot, {
    mode: "refs",
    baseRef: "HEAD~1",
    targetRef: "HEAD",
  });
  assert.ok(allFiles.includes("new.ts"));
  assert.ok(allFiles.includes("renamed.ts"));
  assert.ok(!allFiles.includes("removed.ts"));
  assert.ok(!allFiles.includes("ignored.log"));

  assert.equal(
    await git.getRefContent(fixtureRoot, "HEAD~1", "src/a.ts"),
    "one\n",
  );
  assert.equal(
    await git.getRefContent(fixtureRoot, "HEAD~1", "old.ts"),
    "old\n",
  );

  const refs = await git.getRefItems(fixtureRoot);
  const branch = runGit("branch", "--show-current").trim();
  assert.ok(refs.some((ref) => ref.ref === `refs/heads/${branch}`));
  assert.ok(refs.some((ref) => ref.kind === "commit"));
});

test("GitService compares index with working tree and reads index content", async () => {
  write("src/a.ts", "staged\n");
  runGit("add", "src/a.ts");
  write("src/a.ts", "working\n");
  write("draft.ts", "draft\n");

  const changes = await git.getChanges(fixtureRoot, { mode: "index" });
  const byPath = new Map(changes.map((change) => [change.path, change]));

  assert.equal(byPath.get("src/a.ts")?.status, "M");
  assert.equal(byPath.get("draft.ts")?.status, "A");
  assert.equal(await git.getIndexContent(fixtureRoot, "src/a.ts"), "staged\n");

  const allFiles = await git.getAllFiles(fixtureRoot, { mode: "index" });
  assert.ok(allFiles.includes("src/a.ts"));
  assert.ok(allFiles.includes("draft.ts"));
  assert.ok(!allFiles.includes("ignored.log"));
});

test("GitService treats all files as additions in a repository without commits", async () => {
  const unbornRoot = path.join(fixtureRoot, "unborn");
  fs.mkdirSync(unbornRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], {
    cwd: unbornRoot,
    windowsHide: true,
  });
  fs.writeFileSync(path.join(unbornRoot, "tracked.ts"), "tracked\n", "utf8");
  execFileSync("git", ["add", "tracked.ts"], {
    cwd: unbornRoot,
    windowsHide: true,
  });
  fs.writeFileSync(
    path.join(unbornRoot, "untracked.ts"),
    "untracked\n",
    "utf8",
  );

  const changes = await git.getChanges(unbornRoot, {
    mode: "working",
    baseRef: "HEAD",
  });
  const byPath = new Map(changes.map((change) => [change.path, change]));

  assert.equal(byPath.get("tracked.ts")?.status, "A");
  assert.equal(byPath.get("untracked.ts")?.status, "A");
  assert.deepEqual(await git.getRefItems(unbornRoot), []);
});

test("GitService discovers repositories nested below a non-repository workspace folder", async () => {
  const appRoot = path.join(nestedWorkspaceRoot, "app");
  const libraryRoot = path.join(nestedWorkspaceRoot, "packages", "lib");
  const ignoredRoot = path.join(
    nestedWorkspaceRoot,
    "node_modules",
    "dependency",
  );

  for (const root of [appRoot, libraryRoot, ignoredRoot]) {
    fs.mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q"], {
      cwd: root,
      windowsHide: true,
    });
  }

  const repositories = await git.discoverRepositories([
    nestedWorkspaceRoot,
  ]);
  assert.deepEqual(
    repositories.map((repository) => repository.root),
    [appRoot, libraryRoot],
  );
  assert.ok(
    repositories.every((repository) => repository.root !== nestedWorkspaceRoot),
  );
});

test("GitService includes repositories supplied by the VS Code Git extension", async () => {
  const knownRoot = path.join(nestedWorkspaceRoot, "known", "service");
  fs.mkdirSync(knownRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], {
    cwd: knownRoot,
    windowsHide: true,
  });

  const repositories = await git.discoverRepositories([], {
    knownRoots: [knownRoot],
  });
  assert.deepEqual(
    repositories.map((repository) => repository.root),
    [knownRoot],
  );
});
