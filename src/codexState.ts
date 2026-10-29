import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ChangeStatus,
  ComparisonState,
  RepositoryInfo,
} from "./types";

export interface CodexFileReference {
  repositoryRoot: string;
  filePath: string;
  oldPath?: string;
  status?: ChangeStatus;
}

export interface CodexVisibleChange extends CodexFileReference {
  repositoryName: string;
  status: ChangeStatus;
}

export interface CodexActiveDiff extends CodexFileReference {
  repositoryName: string;
  baseLabel: string;
  targetLabel: string;
  left: string;
  right: string;
  error?: string;
  truncated?: boolean;
}

export interface CodexRepositoryComparison {
  repositoryRoot: string;
  comparison: ComparisonState;
}

export interface CodexViewState {
  schemaVersion: 1;
  updatedAt: string;
  windowId: string;
  workspaceFolders: string[];
  repositories: RepositoryInfo[];
  visibleRepositories: RepositoryInfo[];
  comparisons: CodexRepositoryComparison[];
  visibleChanges: CodexVisibleChange[];
  selectedFile?: CodexFileReference;
  activeFile?: CodexFileReference;
  activeDiff?: CodexActiveDiff;
}

const STATE_DIRECTORY = path.join(
  os.tmpdir(),
  "git-diff-viewer",
  "codex-state",
);

export function codexStateFilePath(windowId = String(process.pid)): string {
  return path.join(STATE_DIRECTORY, `state-${windowId}.json`);
}

export async function writeCodexViewState(
  state: CodexViewState,
  filePath = codexStateFilePath(state.windowId),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), {
    recursive: true,
    mode: 0o700,
  });
  await fs.writeFile(filePath, JSON.stringify(state), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readCodexViewState(
  cwd = process.cwd(),
  explicitPath = process.env.GIT_DIFF_VIEWER_STATE_PATH,
): Promise<CodexViewState | undefined> {
  if (explicitPath) {
    return readStateFile(explicitPath);
  }

  let entries: string[];
  try {
    entries = await fs.readdir(STATE_DIRECTORY);
  } catch {
    return undefined;
  }

  const states = (
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => readStateFile(path.join(STATE_DIRECTORY, entry))),
    )
  ).filter((state): state is CodexViewState => state !== undefined);

  if (states.length === 0) {
    return undefined;
  }

  const matchingWorkspace = states.filter((state) =>
    state.workspaceFolders.some((folder) => isWithin(folder, cwd)),
  );
  return matchingWorkspace.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  )[0];
}

async function readStateFile(
  filePath: string,
): Promise<CodexViewState | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CodexViewState>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.workspaceFolders) ||
      !Array.isArray(parsed.repositories) ||
      !Array.isArray(parsed.visibleRepositories) ||
      !Array.isArray(parsed.comparisons) ||
      !Array.isArray(parsed.visibleChanges)
    ) {
      return undefined;
    }
    return parsed as CodexViewState;
  } catch {
    return undefined;
  }
}

function isWithin(parent: string, child: string): boolean {
  const normalizedParent = normalizePath(parent);
  const normalizedChild = normalizePath(child);
  const relative = path.relative(normalizedParent, normalizedChild);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizePath(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
