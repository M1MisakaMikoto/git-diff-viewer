import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  CodexViewState,
  writeCodexViewState,
} from "../src/codexState";

const statePath = path.join(
  os.tmpdir(),
  `git-diff-viewer-codex-${process.pid}.json`,
);

after(() => {
  fs.rmSync(statePath, { force: true });
});

test("Codex MCP server exposes the current Git Diff Viewer context", async () => {
  const state: CodexViewState = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    windowId: "test",
    workspaceFolders: [process.cwd()],
    repositories: [
      {
        root: process.cwd(),
        name: "diff-viewer",
        branch: "main",
      },
    ],
    visibleRepositories: [
      {
        root: process.cwd(),
        name: "diff-viewer",
        branch: "main",
      },
    ],
    comparisons: [
      {
        repositoryRoot: process.cwd(),
        comparison: { mode: "working", baseRef: "HEAD" },
      },
    ],
    visibleChanges: [
      {
        repositoryRoot: process.cwd(),
        repositoryName: "diff-viewer",
        filePath: "src/controller.ts",
        oldPath: "src/controller.ts",
        status: "M",
      },
    ],
    activeFile: {
      repositoryRoot: process.cwd(),
      filePath: "src/controller.ts",
      oldPath: "src/controller.ts",
      status: "M",
    },
    activeDiff: {
      repositoryRoot: process.cwd(),
      repositoryName: "diff-viewer",
      filePath: "src/controller.ts",
      oldPath: "src/controller.ts",
      status: "M",
      baseLabel: "HEAD",
      targetLabel: "工作区",
      left: "before\n",
      right: "after\n",
    },
  };
  await writeCodexViewState(state, statePath);

  const child = spawn(
    process.execPath,
    [path.join(process.cwd(), "out", "src", "codexMcpServer.js")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GIT_DIFF_VIEWER_STATE_PATH: statePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  try {
    const responses = await exchangeMcpMessages(child, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_view_context", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_active_diff", arguments: {} },
      },
    ]);

    const toolList = responses.get(2) as {
      result: { tools: Array<{ name: string }> };
    };
    assert.deepEqual(
      toolList.result.tools.map((tool) => tool.name),
      ["get_view_context", "get_active_diff"],
    );

    const context = responses.get(3) as {
      result: { content: Array<{ text: string }> };
    };
    assert.match(context.result.content[0].text, /src\/controller\.ts/);

    const diff = responses.get(4) as {
      result: { content: Array<{ text: string }> };
    };
    assert.match(diff.result.content[0].text, /before/);
    assert.match(diff.result.content[0].text, /after/);
  } finally {
    child.stdin.end();
    child.kill();
  }
});

function exchangeMcpMessages(
  child: ReturnType<typeof spawn>,
  messages: unknown[],
): Promise<Map<number, unknown>> {
  return new Promise((resolve, reject) => {
    const responses = new Map<number, unknown>();
    let buffer = "";
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for MCP responses"));
    }, 5_000);

    child.stderr?.on("data", (chunk) => {
      buffer += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        const response = JSON.parse(line) as {
          id: number;
          error?: unknown;
        };
        if (response.error) {
          clearTimeout(timeout);
          reject(new Error(JSON.stringify(response.error)));
          return;
        }
        responses.set(response.id, response);
      }
      if (responses.size === messages.length) {
        clearTimeout(timeout);
        resolve(responses);
      }
    });

    for (const message of messages) {
      child.stdin?.write(`${JSON.stringify(message)}\n`);
    }
  });
}
