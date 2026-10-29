import {
  ChangeStatus,
  ChangeSummary,
  ComparisonState,
  DirectoryNode,
  FileChange,
  FileNode,
  TreeNode,
} from "./types";

const STATUS_ALIASES: Record<string, ChangeStatus> = {
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  C: "C",
  T: "T",
  U: "U",
};

export function createEmptySummary(): ChangeSummary {
  return {
    added: 0,
    modified: 0,
    deleted: 0,
    renamed: 0,
    total: 0,
  };
}

export function addToSummary(summary: ChangeSummary, change: FileChange): void {
  summary.total += 1;

  switch (change.status) {
    case "A":
      summary.added += 1;
      break;
    case "D":
      summary.deleted += 1;
      break;
    case "R":
    case "C":
      summary.renamed += 1;
      break;
    default:
      summary.modified += 1;
      break;
  }
}

export function mergeSummaries(
  target: ChangeSummary,
  source: ChangeSummary,
): void {
  target.added += source.added;
  target.modified += source.modified;
  target.deleted += source.deleted;
  target.renamed += source.renamed;
  target.total += source.total;
}

export function directoryStateText(summary: ChangeSummary): string {
  if (summary.total === 0) {
    return "无变化";
  }

  if (summary.added === summary.total) {
    return "新增";
  }

  if (summary.added > 0) {
    return "修改 + 新增";
  }

  return "修改";
}

export function directoryCountsText(summary: ChangeSummary): string {
  const parts: string[] = [];

  if (summary.modified > 0) {
    parts.push(`修改 ${summary.modified}`);
  }
  if (summary.added > 0) {
    parts.push(`新增 ${summary.added}`);
  }
  if (summary.deleted > 0) {
    parts.push(`删除 ${summary.deleted}`);
  }
  if (summary.renamed > 0) {
    parts.push(`重命名 ${summary.renamed}`);
  }

  return parts.join(" · ");
}

export function fileStatusLabel(status: ChangeStatus): string {
  switch (status) {
    case "A":
      return "新增";
    case "M":
      return "修改";
    case "D":
      return "删除";
    case "R":
      return "重命名";
    case "C":
      return "复制";
    case "T":
      return "类型变更";
    case "U":
      return "冲突";
    default:
      return status;
  }
}

export function fileStatusBadge(status: ChangeStatus): string {
  return status;
}

export function comparisonLabel(state: ComparisonState): string {
  switch (state.mode) {
    case "working":
      return `${displayRef(state.baseRef ?? "HEAD")} ↔ 工作区`;
    case "refs":
      return `${displayRef(state.baseRef ?? "HEAD")} ↔ ${displayRef(
        state.targetRef ?? "HEAD",
      )}`;
    case "index":
      return "暂存区 ↔ 工作区";
    default:
      return "未知对比";
  }
}

export function comparisonSideLabels(state: ComparisonState): {
  base: string;
  target: string;
} {
  switch (state.mode) {
    case "working":
      return { base: displayRef(state.baseRef ?? "HEAD"), target: "工作区" };
    case "refs":
      return {
        base: displayRef(state.baseRef ?? "HEAD"),
        target: displayRef(state.targetRef ?? "HEAD"),
      };
    case "index":
      return { base: "暂存区", target: "工作区" };
    default:
      return { base: "基准", target: "目标" };
  }
}

export function displayRef(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^refs\/tags\//, "");
}

export function parseNameStatus(raw: string): FileChange[] {
  if (!raw) {
    return [];
  }

  if (!raw.includes("\0")) {
    return parseLineSeparatedNameStatus(raw);
  }

  const fields = raw.split("\0");
  const changes: FileChange[] = [];
  let index = 0;

  while (index < fields.length) {
    let token = fields[index++];
    while (token === "" && index < fields.length) {
      token = fields[index++];
    }
    if (!token) {
      break;
    }

    const parsedStatus = parseStatusToken(token);
    const { status, similarity } = parsedStatus;

    if (status === "R" || status === "C") {
      const oldPath = fields[index++];
      const path = fields[index++];

      if (oldPath === undefined || path === undefined) {
        break;
      }

      changes.push({ status, oldPath, path, similarity });
      continue;
    }

    const path = fields[index++];
    if (path === undefined) {
      break;
    }

    changes.push({
      status,
      oldPath: path,
      path,
      similarity,
    });
  }

  return changes;
}

function parseLineSeparatedNameStatus(raw: string): FileChange[] {
  const changes: FileChange[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line) {
      continue;
    }

    const fields = line.split("\t");
    const statusToken = fields.shift();
    if (!statusToken) {
      continue;
    }

    const { status, similarity } = parseStatusToken(statusToken);
    const path = fields[0];
    if (!path) {
      continue;
    }

    if (status === "R" || status === "C") {
      const oldPath = fields[0];
      const renamedPath = fields[1];
      if (oldPath && renamedPath) {
        changes.push({
          status,
          oldPath,
          path: renamedPath,
          similarity,
        });
      }
      continue;
    }

    changes.push({
      status,
      oldPath: path,
      path,
      similarity,
    });
  }

  return changes;
}

function parseStatusToken(token: string): {
  status: ChangeStatus;
  similarity?: number;
} {
  const statusCode = token[0]?.toUpperCase() ?? "M";
  const status = STATUS_ALIASES[statusCode] ?? "M";
  const similarityMatch = token.match(/\d+/);
  const similarity = similarityMatch
    ? Number.parseInt(similarityMatch[0], 10)
    : undefined;

  return { status, similarity };
}

export function buildChangeTree(
  changes: FileChange[],
  repoRoot: string,
  rootName: string,
): TreeNode[] {
  interface MutableDirectory {
    name: string;
    relativePath: string;
    directories: Map<string, MutableDirectory>;
    files: FileNode[];
    summary: ChangeSummary;
  }

  const root: MutableDirectory = {
    name: "",
    relativePath: "",
    directories: new Map(),
    files: [],
    summary: createEmptySummary(),
  };

  for (const change of changes) {
    const normalizedPath = change.path.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.length === 0) {
      continue;
    }

    let directory = root;
    addToSummary(directory.summary, change);

    for (let segmentIndex = 0; segmentIndex < segments.length - 1; segmentIndex++) {
      const segment = segments[segmentIndex];
      let child = directory.directories.get(segment);

      if (!child) {
        const relativePath = directory.relativePath
          ? `${directory.relativePath}/${segment}`
          : segment;
        child = {
          name: segment,
          relativePath,
          directories: new Map(),
          files: [],
          summary: createEmptySummary(),
        };
        directory.directories.set(segment, child);
      }

      addToSummary(child.summary, change);
      directory = child;
    }

    directory.files.push({
      kind: "file",
      repoRoot,
      rootName,
      change,
    });
  }

  const toTreeNodes = (directory: MutableDirectory): TreeNode[] => {
    const directories: DirectoryNode[] = Array.from(
      directory.directories.values(),
    )
      .sort((left, right) => compareNames(left.name, right.name))
      .map((child) => ({
        kind: "directory",
        repoRoot,
        rootName,
        name: child.name,
        relativePath: child.relativePath,
        children: toTreeNodes(child),
        summary: child.summary,
      }));

    const files = directory.files
      .slice()
      .sort((left, right) =>
        compareNames(left.change.path, right.change.path),
      );

    return [...directories, ...files];
  };

  return toTreeNodes(root);
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
