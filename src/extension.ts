import * as vscode from "vscode";
import { DiffViewerController } from "./controller";

let controller: DiffViewerController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  controller = new DiffViewerController(context);
  context.subscriptions.push(controller);
}

export function deactivate(): void {
  controller?.dispose();
  controller = undefined;
}
