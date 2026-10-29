export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface FileChange {
  status: ChangeStatus;
  oldPath: string;
  path: string;
  similarity?: number;
}

export type ComparisonMode = "working" | "refs" | "index";

export interface ComparisonState {
  mode: ComparisonMode;
  baseRef?: string;
  targetRef?: string;
}

export interface RepositoryInfo {
  root: string;
  name: string;
  branch: string;
}

export interface ChangeSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  total: number;
}

export interface DirectoryNode {
  kind: "directory";
  repoRoot: string;
  rootName: string;
  name: string;
  relativePath: string;
  children: TreeNode[];
  summary: ChangeSummary;
}

export interface FileNode {
  kind: "file";
  repoRoot: string;
  rootName: string;
  filePath: string;
  change?: FileChange;
}

export interface RepositoryNode {
  kind: "repository";
  snapshot: RepositorySnapshot;
}

export interface MessageNode {
  kind: "message";
  label: string;
  description?: string;
  icon?: "info" | "warning" | "error";
  command?: {
    command: string;
    title: string;
    arguments?: unknown[];
  };
}

export type TreeNode = DirectoryNode | FileNode | RepositoryNode | MessageNode;

export interface RepositorySnapshot {
  repository: RepositoryInfo;
  comparison: ComparisonState;
  changes: FileChange[];
  roots: TreeNode[];
  error?: string;
}
