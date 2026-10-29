import * as path from "node:path";
import * as vscode from "vscode";
import {
  createVirtualContentUri,
  GIT_DIFF_SCHEME,
  GitContentProvider,
} from "./contentProvider";
import { GitRefItem, GitService } from "./git";
import {
  buildChangeTree,
  comparisonLabel,
  comparisonSideLabels,
} from "./model";
import { ChangesTreeProvider, diffTitle } from "./treeProvider";
import {
  ComparisonState,
  DirectoryNode,
  FileNode,
  RepositoryInfo,
  RepositoryNode,
  RepositorySnapshot,
  TreeNode,
} from "./types";

const VIEW_ID = "gitDiffViewer.changes";
const COMPARISON_STATE_KEY = "gitDiffViewer.comparisonStates";
const DEFAULT_COMPARISON: ComparisonState = {
  mode: "working",
  baseRef: "HEAD",
};

interface ComparisonChoice extends vscode.QuickPickItem {
  action: "head" | "working" | "refs" | "index";
}

interface RefChoice extends vscode.QuickPickItem {
  ref?: string;
  action?: "input";
}

export class DiffViewerController implements vscode.Disposable {
  private readonly git = new GitService();
  private readonly contentProvider: GitContentProvider;
  private readonly treeProvider: ChangesTreeProvider;
  private readonly treeView: vscode.TreeView<TreeNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly snapshots = new Map<string, RepositorySnapshot>();
  private readonly comparisonStates = new Map<string, ComparisonState>();
  private repositories: RepositoryInfo[] = [];
  private loading = false;
  private refreshGeneration = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.contentProvider = new GitContentProvider(this.git);
    this.treeProvider = new ChangesTreeProvider({
      getRepositories: () => this.repositories,
      getSnapshot: (root) => this.snapshots.get(root),
      isLoading: () => this.loading,
    });
    this.treeView = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true,
    });

    this.loadSavedComparisonStates();
    this.disposables.push(
      this.contentProvider,
      this.treeProvider,
      this.treeView,
      vscode.workspace.registerTextDocumentContentProvider(
        GIT_DIFF_SCHEME,
        this.contentProvider,
      ),
      vscode.commands.registerCommand("gitDiffViewer.refresh", () =>
        this.refresh(),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.chooseComparison",
        (node?: TreeNode) => this.chooseComparison(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.compareHead",
        (node?: TreeNode) => this.compareHead(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.compareWithVersion",
        (node?: TreeNode) => this.compareWithVersion(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.compareVersions",
        (node?: TreeNode) => this.compareVersions(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.compareIndex",
        (node?: TreeNode) => this.compareIndex(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.openDiff",
        (node?: TreeNode) => this.openDiff(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.openFile",
        (node?: TreeNode) => this.openFile(node),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.copyPath",
        (node?: TreeNode) => this.copyPath(node),
      ),
      vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("gitDiffViewer.autoRefresh")
        ) {
          this.configureWatcher();
        }
      }),
    );

    this.configureWatcher();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.loading = true;
    this.treeProvider.refresh();

    try {
      const workspaceFolders =
        vscode.workspace.workspaceFolders?.map(
          (folder) => folder.uri.fsPath,
        ) ?? [];
      const repositories =
        await this.git.discoverRepositories(workspaceFolders);

      if (generation !== this.refreshGeneration) {
        return;
      }

      this.repositories = repositories;
      const nextSnapshots = new Map<string, RepositorySnapshot>();

      await Promise.all(
        repositories.map(async (repository) => {
          const comparison = this.getComparison(repository.root);
          try {
            const changes = await this.git.getChanges(
              repository.root,
              comparison,
            );
            const roots =
              changes.length > 0
                ? buildChangeTree(changes, repository.root, repository.name)
                : [
                    {
                      kind: "message" as const,
                      label: "当前对比没有变更",
                      description: comparisonLabel(comparison),
                      icon: "info" as const,
                      command: {
                        command: "gitDiffViewer.chooseComparison",
                        title: "选择对比范围",
                      },
                    },
                  ];

            nextSnapshots.set(repository.root, {
              repository,
              comparison,
              changes,
              roots,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            nextSnapshots.set(repository.root, {
              repository,
              comparison,
              changes: [],
              roots: [
                {
                  kind: "message",
                  label: "读取 Git 差异失败",
                  description: message,
                  icon: "error",
                  command: {
                    command: "gitDiffViewer.chooseComparison",
                    title: "选择对比范围",
                  },
                },
              ],
              error: message,
            });
          }
        }),
      );

      if (generation !== this.refreshGeneration) {
        return;
      }

      this.snapshots.clear();
      for (const [root, snapshot] of nextSnapshots) {
        this.snapshots.set(root, snapshot);
      }
      this.contentProvider.clearCache();
      await vscode.commands.executeCommand(
        "setContext",
        "gitDiffViewer.hasRepository",
        repositories.length > 0,
      );
      this.updateViewChrome();
    } finally {
      if (generation === this.refreshGeneration) {
        this.loading = false;
        this.treeProvider.refresh();
      }
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.fileWatcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async chooseComparison(node?: TreeNode): Promise<void> {
    const repository = await this.resolveRepository(node);
    if (!repository) {
      return;
    }

    const current = this.getComparison(repository.root);
    const choices: ComparisonChoice[] = [
      {
        label: "$(history) 工作区与 HEAD 对比",
        description:
          current.mode === "working" && current.baseRef === "HEAD"
            ? "当前"
            : undefined,
        action: "head",
      },
      {
        label: "$(git-compare) 工作区与指定版本对比…",
        description:
          current.mode === "working" && current.baseRef !== "HEAD"
            ? `当前：${current.baseRef}`
            : undefined,
        action: "working",
      },
      {
        label: "$(versions) 两个版本对比…",
        description:
          current.mode === "refs" ? comparisonLabel(current) : undefined,
        action: "refs",
      },
      {
        label: "$(diff) 暂存区与工作区对比",
        description: current.mode === "index" ? "当前" : undefined,
        action: "index",
      },
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      title: `选择对比范围 · ${repository.name}`,
      placeHolder: "选择要浏览的 Git 差异范围",
    });
    if (!selected) {
      return;
    }

    switch (selected.action) {
      case "head":
        await this.setComparison(repository, {
          mode: "working",
          baseRef: "HEAD",
        });
        break;
      case "working": {
        const ref = await this.pickRef(
          repository,
          "工作区与指定版本对比",
          "选择作为基准的版本",
        );
        if (ref) {
          await this.setComparison(repository, {
            mode: "working",
            baseRef: ref,
          });
        }
        break;
      }
      case "refs":
        await this.pickTwoRefs(repository);
        break;
      case "index":
        await this.setComparison(repository, { mode: "index" });
        break;
    }
  }

  private async compareHead(node?: TreeNode): Promise<void> {
    const repository = await this.resolveRepository(node);
    if (!repository) {
      return;
    }
    await this.setComparison(repository, {
      mode: "working",
      baseRef: "HEAD",
    });
  }

  private async compareWithVersion(node?: TreeNode): Promise<void> {
    const repository = await this.resolveRepository(node);
    if (!repository) {
      return;
    }

    const ref = await this.pickRef(
      repository,
      "工作区与指定版本对比",
      "选择作为基准的版本",
    );
    if (ref) {
      await this.setComparison(repository, {
        mode: "working",
        baseRef: ref,
      });
    }
  }

  private async compareVersions(node?: TreeNode): Promise<void> {
    const repository = await this.resolveRepository(node);
    if (!repository) {
      return;
    }
    await this.pickTwoRefs(repository);
  }

  private async compareIndex(node?: TreeNode): Promise<void> {
    const repository = await this.resolveRepository(node);
    if (!repository) {
      return;
    }
    await this.setComparison(repository, { mode: "index" });
  }

  private async pickTwoRefs(repository: RepositoryInfo): Promise<void> {
    const baseRef = await this.pickRef(
      repository,
      "两个版本对比",
      "选择左侧（基准）版本",
    );
    if (!baseRef) {
      return;
    }

    const targetRef = await this.pickRef(
      repository,
      "两个版本对比",
      "选择右侧（目标）版本",
      baseRef,
    );
    if (!targetRef) {
      return;
    }

    await this.setComparison(repository, {
      mode: "refs",
      baseRef,
      targetRef,
    });
  }

  private async pickRef(
    repository: RepositoryInfo,
    title: string,
    placeHolder: string,
    excludedRef?: string,
  ): Promise<string | undefined> {
    let refs: GitRefItem[] = [];
    try {
      refs = await this.git.getRefItems(repository.root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`无法读取版本列表：${message}`);
    }

    const items: RefChoice[] = [
      {
        label: "$(git-commit) HEAD",
        description: `${repository.branch} · 当前提交`,
        ref: "HEAD",
        alwaysShow: true,
      },
    ];

    appendRefGroup(items, "本地分支", refs.filter((ref) => ref.kind === "branch"));
    appendRefGroup(
      items,
      "远程分支",
      refs.filter((ref) => ref.kind === "remote"),
    );
    appendRefGroup(items, "标签", refs.filter((ref) => ref.kind === "tag"));
    appendRefGroup(
      items,
      "最近提交",
      refs.filter((ref) => ref.kind === "commit").slice(0, 40),
    );

    items.push({
      label: "$(edit) 输入提交、分支或标签…",
      action: "input",
      alwaysShow: true,
    });

    const filteredItems =
      excludedRef === undefined
        ? items
        : items.filter(
            (item) =>
              item.action === "input" ||
              item.kind === vscode.QuickPickItemKind.Separator ||
              item.ref !== excludedRef,
          );

    const selected = await vscode.window.showQuickPick(filteredItems, {
      title: `选择版本 · ${repository.name}`,
      placeHolder,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });

    if (!selected) {
      return undefined;
    }

    if (selected.action === "input") {
      const input = await vscode.window.showInputBox({
        title,
        prompt: "输入提交哈希、分支名、标签或类似 HEAD~1 的版本表达式",
        placeHolder: "例如：main、v1.2.0、a1b2c3d、HEAD~2",
        ignoreFocusOut: true,
        validateInput: async (value) => {
          const trimmed = value.trim();
          if (!trimmed) {
            return "版本不能为空";
          }
          if (trimmed === excludedRef) {
            return "请选择与左侧不同的版本";
          }
          return (await this.git.refExists(repository.root, trimmed))
            ? undefined
            : "找不到该提交、分支或标签";
        },
      });
      return input?.trim();
    }

    return selected.ref;
  }

  private async setComparison(
    repository: RepositoryInfo,
    comparison: ComparisonState,
  ): Promise<void> {
    this.comparisonStates.set(repository.root, comparison);
    await this.persistComparisonStates();
    await this.refresh();
  }

  private async openDiff(node?: TreeNode): Promise<void> {
    if (!node || node.kind !== "file") {
      return;
    }

    const snapshot = this.snapshots.get(node.repoRoot);
    if (!snapshot) {
      vscode.window.showWarningMessage("变更数据已过期，请刷新后重试。");
      return;
    }

    const diff = this.createDiffUris(node, snapshot);
    if (!diff) {
      return;
    }

    const labels = comparisonSideLabels(snapshot.comparison);
    await vscode.commands.executeCommand(
      "vscode.diff",
      diff.left,
      diff.right,
      diffTitle(node.change.path, labels.base, labels.target),
      {
        preview: false,
        preserveFocus: false,
      },
    );
  }

  private async openFile(node?: TreeNode): Promise<void> {
    if (!node || node.kind !== "file") {
      return;
    }

    const snapshot = this.snapshots.get(node.repoRoot);
    if (!snapshot) {
      return;
    }

    if (node.change.status === "D") {
      vscode.window.showInformationMessage("该文件在当前目标版本中已删除。");
      return;
    }

    if (snapshot.comparison.mode === "refs") {
      const uri = createVirtualContentUri({
        source: "ref",
        repoRoot: node.repoRoot,
        filePath: node.change.path,
        ref: snapshot.comparison.targetRef ?? "HEAD",
      });
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }

    const fileUri = vscode.Uri.file(
      path.join(node.repoRoot, node.change.path),
    );
    try {
      await vscode.window.showTextDocument(fileUri, { preview: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`无法打开文件：${message}`);
    }
  }

  private async copyPath(node?: TreeNode): Promise<void> {
    if (!node || node.kind !== "file") {
      return;
    }
    await vscode.env.clipboard.writeText(node.change.path);
  }

  private createDiffUris(
    node: FileNode,
    snapshot: RepositorySnapshot,
  ): { left: vscode.Uri; right: vscode.Uri } | undefined {
    const comparison = snapshot.comparison;
    const change = node.change;
    const empty = (filePath: string) =>
      createVirtualContentUri({
        source: "empty",
        repoRoot: node.repoRoot,
        filePath,
      });

    let left: vscode.Uri;
    if (change.status === "A") {
      left = empty(change.oldPath);
    } else if (comparison.mode === "index") {
      left = createVirtualContentUri({
        source: "index",
        repoRoot: node.repoRoot,
        filePath: change.oldPath,
      });
    } else {
      left = createVirtualContentUri({
        source: "ref",
        repoRoot: node.repoRoot,
        filePath: change.oldPath,
        ref: comparison.baseRef ?? "HEAD",
      });
    }

    let right: vscode.Uri;
    if (change.status === "D") {
      right = empty(change.path);
    } else if (comparison.mode === "refs") {
      right = createVirtualContentUri({
        source: "ref",
        repoRoot: node.repoRoot,
        filePath: change.path,
        ref: comparison.targetRef ?? "HEAD",
      });
    } else {
      right = vscode.Uri.file(path.join(node.repoRoot, change.path));
    }

    return { left, right };
  }

  private async resolveRepository(
    node?: TreeNode,
  ): Promise<RepositoryInfo | undefined> {
    if (node?.kind === "repository") {
      return node.snapshot.repository;
    }

    if (node?.kind === "file" || node?.kind === "directory") {
      const root = node.repoRoot;
      return this.repositories.find((repository) => repository.root === root);
    }

    if (this.repositories.length === 0) {
      const action = await vscode.window.showWarningMessage(
        "当前工作区中没有找到 Git 仓库。",
        "刷新",
      );
      if (action === "刷新") {
        await this.refresh();
      }
      return undefined;
    }

    if (this.repositories.length === 1) {
      return this.repositories[0];
    }

    const selected = await vscode.window.showQuickPick(
      this.repositories.map((repository) => ({
        label: repository.name,
        description: repository.branch,
        detail: repository.root,
        repository,
      })),
      {
        title: "选择 Git 仓库",
        placeHolder: "选择要查看差异的仓库",
      },
    );
    return selected?.repository;
  }

  private getComparison(repoRoot: string): ComparisonState {
    return this.comparisonStates.get(repoRoot) ?? DEFAULT_COMPARISON;
  }

  private updateViewChrome(): void {
    if (this.repositories.length === 1) {
      const snapshot = this.snapshots.get(this.repositories[0].root);
      this.treeView.description = snapshot
        ? comparisonLabel(snapshot.comparison)
        : undefined;
    } else if (this.repositories.length > 1) {
      this.treeView.description = `${this.repositories.length} 个仓库`;
    } else {
      this.treeView.description = undefined;
    }

    const total = Array.from(this.snapshots.values()).reduce(
      (count, snapshot) => count + snapshot.changes.length,
      0,
    );
    this.treeView.badge =
      total > 0
        ? {
            value: total,
            tooltip: `${total} 个变更文件`,
          }
        : undefined;
  }

  private scheduleRefresh(): void {
    if (!vscode.workspace.getConfiguration("gitDiffViewer").get("autoRefresh", true)) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 250);
  }

  private configureWatcher(): void {
    this.fileWatcher?.dispose();
    this.fileWatcher = undefined;

    if (!vscode.workspace.getConfiguration("gitDiffViewer").get("autoRefresh", true)) {
      return;
    }

    this.fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.fileWatcher.onDidCreate(() => this.scheduleRefresh());
    this.fileWatcher.onDidChange(() => this.scheduleRefresh());
    this.fileWatcher.onDidDelete(() => this.scheduleRefresh());
  }

  private loadSavedComparisonStates(): void {
    const saved = this.context.workspaceState.get<
      Record<string, ComparisonState>
    >(COMPARISON_STATE_KEY);
    if (!saved) {
      return;
    }

    for (const [repoRoot, comparison] of Object.entries(saved)) {
      if (
        comparison &&
        (comparison.mode === "working" ||
          comparison.mode === "refs" ||
          comparison.mode === "index")
      ) {
        this.comparisonStates.set(repoRoot, comparison);
      }
    }
  }

  private async persistComparisonStates(): Promise<void> {
    const serialized: Record<string, ComparisonState> = {};
    for (const [repoRoot, comparison] of this.comparisonStates) {
      serialized[repoRoot] = comparison;
    }
    await this.context.workspaceState.update(
      COMPARISON_STATE_KEY,
      serialized,
    );
  }
}

function appendRefGroup(
  items: RefChoice[],
  title: string,
  refs: GitRefItem[],
): void {
  if (refs.length === 0) {
    return;
  }

  items.push({
    label: title,
    kind: vscode.QuickPickItemKind.Separator,
  });

  for (const ref of refs) {
    items.push({
      label: ref.label,
      description: ref.description,
      ref: ref.ref,
    });
  }
}
