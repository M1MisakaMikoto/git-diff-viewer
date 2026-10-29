import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChangeTree,
  comparisonLabel,
  directoryCountsText,
  directoryStateText,
  parseNameStatus,
} from "../src/model";
import { DirectoryNode, FileNode, TreeNode } from "../src/types";

test("parseNameStatus parses NUL-delimited modified, added and renamed files", () => {
  const raw = "M\0src/a.ts\0A\0src/new.ts\0R100\0old.ts\0new.ts\0";
  const changes = parseNameStatus(raw);

  assert.deepEqual(changes, [
    { status: "M", oldPath: "src/a.ts", path: "src/a.ts", similarity: undefined },
    { status: "A", oldPath: "src/new.ts", path: "src/new.ts", similarity: undefined },
    { status: "R", oldPath: "old.ts", path: "new.ts", similarity: 100 },
  ]);
});

test("parseNameStatus supports tab-separated output", () => {
  const changes = parseNameStatus("M\tsrc/a.ts\nA\tsrc/new.ts\n");

  assert.equal(changes.length, 2);
  assert.equal(changes[0].path, "src/a.ts");
  assert.equal(changes[1].status, "A");
});

test("buildChangeTree aggregates status by directory", () => {
  const changes = parseNameStatus(
    "M\0src/app/main.ts\0A\0src/app/new.ts\0M\0src/lib/util.ts\0",
  );
  const roots = buildChangeTree(changes, "/repo", "repo");
  const src = roots[0] as DirectoryNode;
  const app = src.children.find(
    (node) => node.kind === "directory" && node.name === "app",
  ) as DirectoryNode;
  const files = app.children as FileNode[];

  assert.equal(src.kind, "directory");
  assert.equal(src.summary.total, 3);
  assert.equal(src.summary.added, 1);
  assert.equal(src.summary.modified, 2);
  assert.equal(directoryStateText(src.summary), "修改 + 新增");
  assert.equal(directoryCountsText(src.summary), "修改 2 · 新增 1");
  assert.equal(app.summary.total, 2);
  assert.equal(files.length, 2);
  assert.equal(files[0].change.path, "src/app/main.ts");
  assert.equal(files[1].change.path, "src/app/new.ts");
});

test("buildChangeTree reports folders containing only additions", () => {
  const changes = parseNameStatus("A\0docs/new-one.md\0A\0docs/new-two.md\0");
  const roots = buildChangeTree(changes, "/repo", "repo");
  const docs = roots[0] as DirectoryNode;

  assert.equal(directoryStateText(docs.summary), "新增");
  assert.equal(directoryCountsText(docs.summary), "新增 2");
});

test("directory descriptions expose a mixed changed-and-added state", () => {
  const changes = parseNameStatus("M\0src/a.ts\0A\0src/b.ts\0");
  const roots: TreeNode[] = buildChangeTree(changes, "/repo", "repo");
  const src = roots[0] as DirectoryNode;

  assert.equal(src.summary.total, 2);
  assert.equal(directoryStateText(src.summary), "修改 + 新增");
  assert.equal(
    `${directoryStateText(src.summary)} · ${src.summary.total}`,
    "修改 + 新增 · 2",
  );
});

test("comparisonLabel describes the active comparison", () => {
  assert.equal(
    comparisonLabel({ mode: "working", baseRef: "v1.2.0" }),
    "v1.2.0 ↔ 工作区",
  );
  assert.equal(
    comparisonLabel({ mode: "refs", baseRef: "main", targetRef: "feature" }),
    "main ↔ feature",
  );
  assert.equal(
    comparisonLabel({
      mode: "refs",
      baseRef: "refs/heads/main",
      targetRef: "refs/tags/v1.0.0",
    }),
    "main ↔ v1.0.0",
  );
  assert.equal(comparisonLabel({ mode: "index" }), "暂存区 ↔ 工作区");
});

test("directories sort before files and use numeric natural ordering", () => {
  const changes = parseNameStatus(
    "A\0file10.ts\0A\0file2.ts\0A\0z/file.ts\0",
  );
  const roots: TreeNode[] = buildChangeTree(changes, "/repo", "repo");

  assert.equal(roots[0].kind, "directory");
  assert.equal((roots[1] as FileNode).change.path, "file2.ts");
  assert.equal((roots[2] as FileNode).change.path, "file10.ts");
});
