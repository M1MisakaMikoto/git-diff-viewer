import * as vscode from "vscode";
import { GitService } from "./git";

export const GIT_DIFF_SCHEME = "git-version-diff-viewer";

export interface VirtualContentQuery {
  source: "ref" | "index" | "empty";
  repoRoot: string;
  filePath: string;
  ref?: string;
}

export function createVirtualContentUri(
  query: VirtualContentQuery,
): vscode.Uri {
  const encodedQuery = Buffer.from(
    JSON.stringify(query),
    "utf8",
  ).toString("base64url");

  return vscode.Uri.from({
    scheme: GIT_DIFF_SCHEME,
    authority: "content",
    path: `/${query.filePath}`,
    query: encodedQuery,
  });
}

export class GitContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly cache = new Map<string, string>();

  constructor(private readonly git: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const query = parseQuery(uri);
    if (!query) {
      return "无法解析该版本文件地址。";
    }

    if (query.source === "empty") {
      return "";
    }

    const cacheKey = uri.toString();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const content =
        query.source === "index"
          ? await this.git.getIndexContent(query.repoRoot, query.filePath)
          : await this.git.getRefContent(
              query.repoRoot,
              query.ref ?? "HEAD",
              query.filePath,
            );
      this.cache.set(cacheKey, content);
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `无法读取 ${query.ref ?? "暂存区"}:${query.filePath}\n\n${message}`;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  dispose(): void {
    this.clearCache();
  }
}

function parseQuery(uri: vscode.Uri): VirtualContentQuery | undefined {
  try {
    const raw = Buffer.from(uri.query, "base64url").toString("utf8");
    return JSON.parse(raw) as VirtualContentQuery;
  } catch {
    return undefined;
  }
}
