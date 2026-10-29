import * as path from "node:path";
import * as vscode from "vscode";
import {
  comparisonLabel,
  directoryCountsText,
  directoryStateText,
  fileStatusBadge,
  fileStatusLabel,
} from "./model";
import {
  ChangeStatus,
  DirectoryNode,
  FileNode,
  MessageNode,
  RepositoryInfo,
  RepositoryNode,
  RepositorySnapshot,
  TreeNode,
} from "./types";

export interface TreeDataHost {
  getRepositories(): RepositoryInfo[];
  getSnapshot(repoRoot: string): RepositorySnapshot | undefined;
  isLoading(): boolean;
}

export class ChangesTreeProvider
  implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly host: TreeDataHost) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const repositories = this.host.getRepositories();

      if (repositories.length === 0) {
        if (this.host.isLoading()) {
          return [
            {
              kind: "message",
              label: "正在读取 Git 仓库…",
              icon: "info",
            },
          ];
        }

        return [
          {
            kind: "message",
            label: "未找到 Git 仓库",
            description: "请打开包含 Git 仓库的工作区",
            icon: "warning",
            command: {
              command: "gitDiffViewer.refresh",
              title: "刷新",
            },
          },
        ];
      }

      if (repositories.length === 1) {
        return this.snapshotRoots(repositories[0].root);
      }

      return repositories.map(
        (repository) =>
          ({
            kind: "repository",
            snapshot: this.host.getSnapshot(repository.root) ?? {
              repository,
              comparison: { mode: "working", baseRef: "HEAD" },
              changes: [],
              roots: [],
            },
          }) satisfies RepositoryNode,
      );
    }

    if (element.kind === "repository") {
      return this.snapshotRoots(element.snapshot.repository.root);
    }

    if (element.kind === "directory") {
      return element.children;
    }

    return [];
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.kind) {
      case "repository":
        return this.repositoryTreeItem(element);
      case "directory":
        return this.directoryTreeItem(element);
      case "file":
        return this.fileTreeItem(element);
      case "message":
        return this.messageTreeItem(element);
      default:
        return new vscode.TreeItem("未知节点");
    }
  }

  dispose(): void {
    this.changed.dispose();
  }

  private snapshotRoots(repoRoot: string): TreeNode[] {
    const snapshot = this.host.getSnapshot(repoRoot);
    if (!snapshot) {
      return [
        {
          kind: "message",
          label: this.host.isLoading() ? "正在读取变更…" : "暂无变更数据",
          icon: "info",
        },
      ];
    }

    return snapshot.roots;
  }

  private repositoryTreeItem(node: RepositoryNode): vscode.TreeItem {
    const snapshot = node.snapshot;
    const item = new vscode.TreeItem(
      snapshot.repository.name,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = `repo:${snapshot.repository.root}`;
    item.description = snapshot.error
      ? "读取失败"
      : comparisonLabel(snapshot.comparison);
    item.contextValue = "gitDiffViewer.repository";
    item.iconPath = new vscode.ThemeIcon("repo");

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${snapshot.repository.name}**  \n`);
    tooltip.appendCodeblock(snapshot.repository.root, "text");
    tooltip.appendMarkdown(`分支：${snapshot.repository.branch}  \n`);
    tooltip.appendMarkdown(`对比：${comparisonLabel(snapshot.comparison)}  \n`);
    tooltip.appendMarkdown(`变更文件：${snapshot.changes.length}`);
    item.tooltip = tooltip;

    return item;
  }

  private directoryTreeItem(node: DirectoryNode): vscode.TreeItem {
    const stateText = directoryStateText(node.summary);
    const countsText = directoryCountsText(node.summary);
    const item = new vscode.TreeItem(
      node.name,
      vscode.TreeItemCollapsibleState.Collapsed,
    );

    item.id = `dir:${node.repoRoot}:${node.relativePath}`;
    item.description =
      node.summary.total > 0
        ? `${stateText} · ${node.summary.total}`
        : undefined;
    item.contextValue = "gitDiffViewer.directory";
    item.iconPath = directoryIcon(node.summary);

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${node.relativePath}/**  \n\n`);
    tooltip.appendMarkdown(`**${stateText}**  \n`);
    if (node.summary.total > 0) {
      tooltip.appendMarkdown(`${countsText}  \n`);
      tooltip.appendMarkdown(`共 ${node.summary.total} 个变更文件`);
    } else {
      tooltip.appendMarkdown("该目录没有 Git 差异");
    }
    item.tooltip = tooltip;

    return item;
  }

  private fileTreeItem(node: FileNode): vscode.TreeItem {
    const change = node.change;
    const filename = node.filePath.split("/").pop() ?? node.filePath;
    const item = new vscode.TreeItem(
      filename,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `file:${node.repoRoot}:${node.filePath}`;
    item.resourceUri = vscode.Uri.file(
      path.join(node.repoRoot, node.filePath),
    );

    if (!change) {
      item.contextValue = "gitDiffViewer.file";
      item.command = {
        command: "gitDiffViewer.openFile",
        title: "打开文件",
        arguments: [node],
      };

      const tooltip = new vscode.MarkdownString();
      tooltip.appendMarkdown(`**${filename}**  \n`);
      tooltip.appendCodeblock(node.filePath, "text");
      tooltip.appendMarkdown("无 Git 差异，点击打开文件。");
      item.tooltip = tooltip;
      return item;
    }

    const statusLabel = fileStatusLabel(change.status);
    const badge =
      change.similarity !== undefined && change.status === "R"
        ? `${fileStatusBadge(change.status)}${change.similarity}%`
        : fileStatusBadge(change.status);

    item.description = `${badge} · ${statusLabel}`;
    item.contextValue = "gitDiffViewer.changedFile";
    item.iconPath = fileIcon(change.status);
    item.command = {
      command: "gitDiffViewer.openDiff",
      title: "打开差异",
      arguments: [node],
    };

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${filename}**  \n`);
    tooltip.appendCodeblock(node.filePath, "text");
    tooltip.appendMarkdown(`状态：${statusLabel} (${badge})  \n`);
    if (
      (change.status === "R" || change.status === "C") &&
      change.oldPath !== change.path
    ) {
      tooltip.appendMarkdown(`原路径：`);
      tooltip.appendCodeblock(change.oldPath, "text");
    }
    tooltip.appendMarkdown("点击打开原生 Git diff。");
    item.tooltip = tooltip;

    return item;
  }

  private messageTreeItem(node: MessageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.iconPath = new vscode.ThemeIcon(
      node.icon === "error"
        ? "error"
        : node.icon === "warning"
          ? "warning"
          : "info",
    );
    if (node.command) {
      item.command = node.command;
    }
    return item;
  }
}

function fileIcon(status: ChangeStatus): vscode.ThemeIcon {
  switch (status) {
    case "A":
      return new vscode.ThemeIcon(
        "diff-added",
        new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      );
    case "D":
      return new vscode.ThemeIcon(
        "diff-removed",
        new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      );
    case "R":
    case "C":
      return new vscode.ThemeIcon(
        "diff-renamed",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
    case "U":
      return new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("gitDecoration.conflictingResourceForeground"),
      );
    default:
      return new vscode.ThemeIcon(
        "diff-modified",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
  }
}

function directoryIcon(
  summary: DirectoryNode["summary"],
): vscode.ThemeIcon {
  if (summary.total === 0) {
    return new vscode.ThemeIcon("folder");
  }

  if (summary.added === summary.total) {
    return new vscode.ThemeIcon(
      "folder",
      new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
    );
  }

  if (summary.deleted === summary.total) {
    return new vscode.ThemeIcon(
      "folder",
      new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
    );
  }

  return new vscode.ThemeIcon(
    "folder",
    new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
  );
}

export function diffTitle(
  changePath: string,
  baseLabel: string,
  targetLabel: string,
): string {
  return `${path.posix.basename(changePath)} (${baseLabel} ↔ ${targetLabel})`;
}
