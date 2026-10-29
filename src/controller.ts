import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  createVirtualContentUri,
  GIT_DIFF_SCHEME,
  GitContentProvider,
} from "./contentProvider";
import { GitRefItem, GitService } from "./git";
import {
  CodexActiveDiff,
  CodexFileReference,
  CodexViewState,
  codexStateFilePath,
  writeCodexViewState,
} from "./codexState";
import {
  configureCodexMcpServer,
  isCodexMcpConfigured,
} from "./codexSetup";
import {
  buildFileTree,
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
const SELECTED_REPOSITORY_KEY = "gitDiffViewer.selectedRepositoryRoot";
const CODEX_CONFIGURED_CONTEXT = "gitDiffViewer.codexConfigured";
const MAX_CODEX_DIFF_CHARS = 100_000;
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

interface RepositoryChoice extends vscode.QuickPickItem {
  repositoryRoot: string | null;
}

interface GitExtensionRepository {
  rootUri: vscode.Uri;
}

interface GitExtensionApi {
  repositories: readonly GitExtensionRepository[];
  onDidOpenRepository?: (
    listener: (repository: GitExtensionRepository) => void,
  ) => vscode.Disposable;
  onDidCloseRepository?: (
    listener: (repository: GitExtensionRepository) => void,
  ) => vscode.Disposable;
}

interface GitExtensionExports {
  getAPI(version: 1): GitExtensionApi;
}

interface ActiveView {
  node: FileNode;
  snapshot: RepositorySnapshot;
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
  private selectedRepositoryRoot: string | undefined;
  private readonly codexStateFile = codexStateFilePath();
  private activeView: ActiveView | undefined;
  private activeDiff: CodexActiveDiff | undefined;
  private selectedFile: CodexFileReference | undefined;
  private activeViewGeneration = 0;
  private codexStateWrite: Promise<void> = Promise.resolve();
  private disposed = false;
  private loading = false;
  private refreshGeneration = 0;
  private refreshTimer: NodeJS.Timeout | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.contentProvider = new GitContentProvider(this.git);
    this.treeProvider = new ChangesTreeProvider({
      getRepositories: () => this.repositories,
      getSnapshot: (root) => this.snapshots.get(root),
      getSelectedRepositoryRoot: () => this.selectedRepositoryRoot,
      isLoading: () => this.loading,
    });
    this.treeView = vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: this.treeProvider,
      showCollapseAll: true,
    });

    this.loadSavedState();
    this.disposables.push(
      this.contentProvider,
      this.treeProvider,
      this.treeView,
      this.treeView.onDidChangeSelection((event) => {
        this.handleTreeSelection(event.selection[0]);
      }),
      vscode.workspace.registerTextDocumentContentProvider(
        GIT_DIFF_SCHEME,
        this.contentProvider,
      ),
      vscode.commands.registerCommand("gitDiffViewer.refresh", () =>
        this.refresh(),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.chooseRepository",
        () => this.chooseRepository(),
      ),
      vscode.commands.registerCommand(
        "gitDiffViewer.setupCodex",
        () => this.setupCodex(),
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
        if (
          event.affectsConfiguration("gitDiffViewer.repositorySearchDepth")
        ) {
          void this.refresh();
        }
      }),
    );

    void vscode.commands.executeCommand(
      "setContext",
      CODEX_CONFIGURED_CONTEXT,
      false,
    );
    void this.registerGitExtensionWatcher();
    void this.detectCodexConfiguration();
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
      const knownRoots = await this.getGitExtensionRepositoryRoots();
      const searchDepth = vscode.workspace
        .getConfiguration("gitDiffViewer")
        .get<number>("repositorySearchDepth", 6);
      const repositories = await this.git.discoverRepositories(
        workspaceFolders,
        {
          knownRoots,
          maxDepth: searchDepth,
        },
      );

      if (generation !== this.refreshGeneration) {
        return;
      }

      this.repositories = repositories;
      if (
        this.selectedRepositoryRoot &&
        !this.findRepositoryByRoot(this.selectedRepositoryRoot)
      ) {
        this.selectedRepositoryRoot = undefined;
        await this.persistSelectedRepository();
      }
      const nextSnapshots = new Map<string, RepositorySnapshot>();

      await Promise.all(
        repositories.map(async (repository) => {
          const comparison = this.getComparison(repository.root);
          try {
            const [changes, filePaths] = await Promise.all([
              this.git.getChanges(repository.root, comparison),
              this.git.getAllFiles(repository.root, comparison),
            ]);
            const roots =
              filePaths.length > 0 || changes.length > 0
                ? buildFileTree(
                    filePaths,
                    changes,
                    repository.root,
                    repository.name,
                  )
                : [
                    {
                      kind: "message" as const,
                      label: "仓库中没有可浏览的文件",
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
      if (this.activeView) {
        const snapshot = this.snapshots.get(this.activeView.node.repoRoot);
        if (snapshot) {
          this.activeView = { ...this.activeView, snapshot };
          this.activeViewGeneration += 1;
          void this.captureActiveDiff(this.activeView.node, snapshot);
        }
      }
      void this.persistCodexViewState();
    } finally {
      if (generation === this.refreshGeneration) {
        this.loading = false;
        this.treeProvider.refresh();
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    void fs.unlink(this.codexStateFile).catch(() => undefined);
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.fileWatcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  private async chooseRepository(): Promise<void> {
    if (this.repositories.length === 0) {
      const action = await vscode.window.showWarningMessage(
        "当前工作区中没有找到 Git 仓库。",
        "刷新",
      );
      if (action === "刷新") {
        await this.refresh();
      }
      return;
    }

    const selectedRepository = this.getSelectedRepository();
    const choices: RepositoryChoice[] = [
      {
        label: "$(repo) 全部仓库",
        description: `${this.repositories.length} 个仓库`,
        repositoryRoot: null,
        picked: selectedRepository === undefined,
      },
      ...this.repositories.map((repository) => ({
        label: repository.name,
        description: repository.branch,
        detail: repository.root,
        repositoryRoot: repository.root,
        picked: selectedRepository?.root === repository.root,
      })),
    ];

    const selected = await vscode.window.showQuickPick(choices, {
      title: "选择 Git 仓库",
      placeHolder: "选择要显示的仓库，或同时浏览全部仓库",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!selected) {
      return;
    }

    this.selectedRepositoryRoot = selected.repositoryRoot ?? undefined;
    await this.persistSelectedRepository();
    this.updateViewChrome();
    this.treeProvider.refresh();
    void this.persistCodexViewState();
  }

  private async detectCodexConfiguration(): Promise<void> {
    const configured = await isCodexMcpConfigured();
    if (!this.disposed) {
      await vscode.commands.executeCommand(
        "setContext",
        CODEX_CONFIGURED_CONTEXT,
        configured,
      );
    }
  }

  private async setupCodex(): Promise<void> {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "配置 Codex 集成",
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: "正在注册本地 MCP 服务…" });
          const serverScript = this.context.asAbsolutePath(
            path.join("out", "src", "codexMcpServer.js"),
          );
          await configureCodexMcpServer(serverScript);
          await this.persistCodexViewState();
        },
      );
      await vscode.commands.executeCommand(
        "setContext",
        CODEX_CONFIGURED_CONTEXT,
        true,
      );
      vscode.window.showInformationMessage(
        "Codex 集成已配置。新开一个 Codex 会话即可读取当前 Git Diff Viewer 视图。",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `配置 Codex 集成失败：${message}`,
      );
    }
  }

  private handleTreeSelection(node: TreeNode | undefined): void {
    if (node?.kind !== "file") {
      this.selectedFile = undefined;
    } else {
      this.selectedFile = fileReference(node);
    }
    void this.persistCodexViewState();
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

    if (!node.change) {
      await this.openFile(node);
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

    this.setActiveView(node, snapshot);

    const labels = comparisonSideLabels(snapshot.comparison);
    await vscode.commands.executeCommand(
      "vscode.diff",
      diff.left,
      diff.right,
      diffTitle(node.filePath, labels.base, labels.target),
      {
        preview: false,
        preserveFocus: false,
      },
    );
    void this.captureActiveDiff(node, snapshot);
  }

  private async openFile(node?: TreeNode): Promise<void> {
    if (!node || node.kind !== "file") {
      return;
    }

    const snapshot = this.snapshots.get(node.repoRoot);
    if (!snapshot) {
      return;
    }

    if (node.change?.status === "D") {
      vscode.window.showInformationMessage("该文件在当前目标版本中已删除。");
      return;
    }

    this.setActiveView(node, snapshot);

    if (snapshot.comparison.mode === "refs") {
      const uri = createVirtualContentUri({
        source: "ref",
        repoRoot: node.repoRoot,
        filePath: node.filePath,
        ref: snapshot.comparison.targetRef ?? "HEAD",
      });
      await vscode.window.showTextDocument(uri, { preview: true });
      return;
    }

    const fileUri = vscode.Uri.file(
      path.join(node.repoRoot, node.filePath),
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
    await vscode.env.clipboard.writeText(node.filePath);
  }

  private createDiffUris(
    node: FileNode,
    snapshot: RepositorySnapshot,
  ): { left: vscode.Uri; right: vscode.Uri } | undefined {
    const comparison = snapshot.comparison;
    const change = node.change;
    if (!change) {
      return undefined;
    }
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

  private setActiveView(
    node: FileNode,
    snapshot: RepositorySnapshot,
  ): void {
    this.activeView = { node, snapshot };
    this.activeDiff = undefined;
    this.activeViewGeneration += 1;
    void this.persistCodexViewState();
  }

  private async captureActiveDiff(
    node: FileNode,
    snapshot: RepositorySnapshot,
  ): Promise<void> {
    if (!node.change) {
      return;
    }

    const generation = this.activeViewGeneration;
    const labels = comparisonSideLabels(snapshot.comparison);
    try {
      const [left, right] = await Promise.all([
        this.readDiffSide(node, snapshot, "left"),
        this.readDiffSide(node, snapshot, "right"),
      ]);
      if (
        generation !== this.activeViewGeneration ||
        !this.isActiveFile(node)
      ) {
        return;
      }

      const truncated =
        left.length > MAX_CODEX_DIFF_CHARS ||
        right.length > MAX_CODEX_DIFF_CHARS;
      this.activeDiff = {
        repositoryRoot: node.repoRoot,
        repositoryName: snapshot.repository.name,
        filePath: node.filePath,
        oldPath: node.change.oldPath,
        status: node.change.status,
        baseLabel: labels.base,
        targetLabel: labels.target,
        left: truncate(left, MAX_CODEX_DIFF_CHARS),
        right: truncate(right, MAX_CODEX_DIFF_CHARS),
        truncated,
      };
    } catch (error) {
      if (
        generation !== this.activeViewGeneration ||
        !this.isActiveFile(node)
      ) {
        return;
      }
      this.activeDiff = {
        repositoryRoot: node.repoRoot,
        repositoryName: snapshot.repository.name,
        filePath: node.filePath,
        oldPath: node.change.oldPath,
        status: node.change.status,
        baseLabel: labels.base,
        targetLabel: labels.target,
        left: "",
        right: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.persistCodexViewState();
  }

  private isActiveFile(node: FileNode): boolean {
    return (
      this.activeView?.node.repoRoot === node.repoRoot &&
      this.activeView.node.filePath === node.filePath
    );
  }

  private async readDiffSide(
    node: FileNode,
    snapshot: RepositorySnapshot,
    side: "left" | "right",
  ): Promise<string> {
    const change = node.change;
    if (!change) {
      return "";
    }

    if (side === "left") {
      if (change.status === "A") {
        return "";
      }
      if (snapshot.comparison.mode === "index") {
        return this.git.getIndexContent(node.repoRoot, change.oldPath);
      }
      return this.git.getRefContent(
        node.repoRoot,
        snapshot.comparison.baseRef ?? "HEAD",
        change.oldPath,
      );
    }

    if (change.status === "D") {
      return "";
    }
    if (snapshot.comparison.mode === "refs") {
      return this.git.getRefContent(
        node.repoRoot,
        snapshot.comparison.targetRef ?? "HEAD",
        change.path,
      );
    }
    return fs.readFile(path.join(node.repoRoot, change.path), "utf8");
  }

  private async persistCodexViewState(): Promise<void> {
    const selectedRepository = this.getSelectedRepository();
    const visibleRepositories = selectedRepository
      ? [selectedRepository]
      : this.repositories;
    const visibleChanges = visibleRepositories.flatMap((repository) =>
      (this.snapshots.get(repository.root)?.changes ?? []).map((change) => ({
        repositoryRoot: repository.root,
        repositoryName: repository.name,
        filePath: change.path,
        oldPath: change.oldPath,
        status: change.status,
      })),
    );

    const state: CodexViewState = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      windowId: String(process.pid),
      workspaceFolders:
        vscode.workspace.workspaceFolders?.map(
          (folder) => folder.uri.fsPath,
        ) ?? [],
      repositories: this.repositories,
      visibleRepositories,
      comparisons: visibleRepositories.map((repository) => ({
        repositoryRoot: repository.root,
        comparison: this.getComparison(repository.root),
      })),
      visibleChanges,
      selectedFile: this.selectedFile,
      activeFile: this.activeView
        ? fileReference(this.activeView.node)
        : undefined,
      activeDiff: this.activeDiff,
    };

    this.codexStateWrite = this.codexStateWrite
      .catch(() => undefined)
      .then(() => writeCodexViewState(state, this.codexStateFile))
      .catch((error) => {
        console.warn("Failed to write Codex view state", error);
      });
    await this.codexStateWrite;
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

    const selectedRepository = this.getSelectedRepository();
    if (selectedRepository) {
      return selectedRepository;
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

  private getSelectedRepository(): RepositoryInfo | undefined {
    return this.selectedRepositoryRoot
      ? this.findRepositoryByRoot(this.selectedRepositoryRoot)
      : undefined;
  }

  private findRepositoryByRoot(
    repoRoot: string,
  ): RepositoryInfo | undefined {
    return this.repositories.find((repository) =>
      samePath(repository.root, repoRoot),
    );
  }

  private updateViewChrome(): void {
    const selectedRepository = this.getSelectedRepository();
    if (selectedRepository) {
      const snapshot = this.snapshots.get(selectedRepository.root);
      this.treeView.description = snapshot
        ? `${selectedRepository.name} · ${comparisonLabel(snapshot.comparison)}`
        : selectedRepository.name;
    } else if (this.repositories.length === 1) {
      const snapshot = this.snapshots.get(this.repositories[0].root);
      this.treeView.description = snapshot
        ? comparisonLabel(snapshot.comparison)
        : undefined;
    } else if (this.repositories.length > 1) {
      this.treeView.description = `${this.repositories.length} 个仓库`;
    } else {
      this.treeView.description = undefined;
    }

    const visibleRoots = selectedRepository
      ? new Set([selectedRepository.root])
      : new Set(this.repositories.map((repository) => repository.root));
    const total = Array.from(this.snapshots.entries()).reduce(
      (count, [root, snapshot]) =>
        visibleRoots.has(root) ? count + snapshot.changes.length : count,
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

  private async getGitExtensionApi(): Promise<
    GitExtensionApi | undefined
  > {
    const extension =
      vscode.extensions.getExtension<GitExtensionExports>("vscode.git");
    if (!extension) {
      return undefined;
    }

    try {
      const exports = extension.isActive
        ? extension.exports
        : await extension.activate();
      return exports?.getAPI(1);
    } catch {
      return undefined;
    }
  }

  private async getGitExtensionRepositoryRoots(): Promise<string[]> {
    const api = await this.getGitExtensionApi();
    return (
      api?.repositories.map((repository) => repository.rootUri.fsPath) ?? []
    );
  }

  private async registerGitExtensionWatcher(): Promise<void> {
    const api = await this.getGitExtensionApi();
    if (!api || this.disposed) {
      return;
    }

    if (api.onDidOpenRepository) {
      this.disposables.push(
        api.onDidOpenRepository(() => this.scheduleRefresh()),
      );
    }
    if (api.onDidCloseRepository) {
      this.disposables.push(
        api.onDidCloseRepository(() => this.scheduleRefresh()),
      );
    }
  }

  private loadSavedState(): void {
    this.loadSavedComparisonStates();
    const root = this.context.workspaceState.get<string>(
      SELECTED_REPOSITORY_KEY,
    );
    this.selectedRepositoryRoot = root || undefined;
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

  private async persistSelectedRepository(): Promise<void> {
    await this.context.workspaceState.update(
      SELECTED_REPOSITORY_KEY,
      this.selectedRepositoryRoot,
    );
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

function fileReference(node: FileNode): CodexFileReference {
  return {
    repositoryRoot: node.repoRoot,
    filePath: node.filePath,
    oldPath: node.change?.oldPath,
    status: node.change?.status,
  };
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength)}\n\n[truncated]`
    : value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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
