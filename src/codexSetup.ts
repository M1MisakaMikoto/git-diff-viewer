import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";

export const CODEX_MCP_SERVER_NAME = "git-diff-viewer";

export async function isCodexMcpConfigured(): Promise<boolean> {
  try {
    const output = await runCodex(["mcp", "list"]);
    return output.includes(CODEX_MCP_SERVER_NAME);
  } catch {
    return false;
  }
}

export async function configureCodexMcpServer(
  serverScriptPath: string,
): Promise<void> {
  await fs.access(serverScriptPath);
  await runCodex(["mcp", "remove", CODEX_MCP_SERVER_NAME]).catch(
    () => undefined,
  );
  await runCodex([
    "mcp",
    "add",
    CODEX_MCP_SERVER_NAME,
    "--",
    "node",
    serverScriptPath,
  ]);
}

function runCodex(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const options = {
      encoding: "utf8" as const,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    };

    if (process.platform !== "win32") {
      execFile("codex", args, options, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      });
      return;
    }

    const command = ["codex", ...args.map(quoteForCmd)].join(" ");
    execFile(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", command],
      options,
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function quoteForCmd(value: string): string {
  if (!/[\s"&|<>^()]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}
