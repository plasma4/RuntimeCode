/*---------------------------------------------------------------------------------------------
 *  RuntimeCode: extension scaffold
 *
 *  This is deliberately not Python yet. It is the smallest extension that
 *  still exercises every part of the extension API you need to know before
 *  writing one that does real work:
 *
 *    - activate()/deactivate() and the ExtensionContext lifecycle
 *    - registering commands that show up in the Command Palette
 *    - reading contributed settings
 *    - the four UI surfaces: notifications, quick pick, input box, status bar
 *    - a webview panel, which is how an extension draws its own UI
 *
 *  The manifest in package.json is the other half. The `contributes` section
 *  there is what makes a command, keybinding or setting exist at all; this file
 *  only supplies their behaviour. Add a command in one and forget the other,
 *  and nothing happens with no error.
 *
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
"use strict";

// The web extension host loads this file as CommonJS by wrapping it in
// `new Function('module','exports','require', src)` (extHostExtensionService.ts),
// so it has to stay a single, dependency-free file. There is no bundler and no
// relative require: only 'vscode' resolves.

const vscode = require("vscode");

/** Everything this extension contributes is namespaced under one section. */
const CONFIG_SECTION = "runtimecode.shell";

/**
 * The placeholder list the picker shows. A real runtime host would build this
 * from the runtimes it found installed (see RUNTIMES.md); here it is static so
 * the UI can be read without any runtime behind it.
 *
 * @type {readonly vscode.QuickPickItem[]}
 */
const RUNTIMES = [
  {
    label: "$(beaker) Python (quick)",
    description: "Pyodide",
    detail: "Smallest download, richest package ecosystem. Not installed yet.",
  },
  {
    label: "$(file-code) Python (faithful)",
    description: "CPython on WASI",
    detail: "Unpatched upstream build. Not installed yet.",
  },
];

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // An output channel is the extension's own log, shown under View > Output.
  // Cheap, and the first place to look when something does not appear.
  const output = vscode.window.createOutputChannel("Runtime Shell");
  output.appendLine("Runtime Shell activated.");
  output.appendLine(
    "Commands live under the 'Runtime Shell' category in the Command Palette.",
  );

  // The status bar item is the simplest always-visible UI surface. Clicking it
  // runs a command, so it is also the shortest path from the UI back into code.
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.name = "Runtime Shell";
  status.text = "$(play) Runtime Shell";
  status.tooltip = "Pick a runtime";
  status.command = "runtimecode.shell.pickRuntime";
  status.show();

  // State belongs in activate()'s closure. This counter survives for as long as
  // the extension is active and is gone on reload, which is usually what you
  // want; use context.globalState for anything that must outlive the session.
  let greetingCount = 0;

  const hello = vscode.commands.registerCommand(
    "runtimecode.shell.hello",
    async () => {
      greetingCount += 1;
      const greeting = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get("greeting", "world");
      output.appendLine(`hello ${greeting} (#${greetingCount})`);

      // A notification can carry buttons; the resolved value is the label of
      // the one the user clicked, or undefined if it was dismissed.
      const action = await vscode.window.showInformationMessage(
        `Hello, ${greeting}. (greeting #${greetingCount})`,
        "Pick a runtime",
        "Open panel",
      );
      if (action === "Pick a runtime") {
        await vscode.commands.executeCommand("runtimecode.shell.pickRuntime");
      } else if (action === "Open panel") {
        await vscode.commands.executeCommand("runtimecode.shell.openPanel");
      }
    },
  );

  const greet = vscode.commands.registerCommand(
    "runtimecode.shell.greet",
    async () => {
      // validateInput is only advisory: returning a string keeps the box open
      // and shows the message, but the user can still press Escape.
      const name = await vscode.window.showInputBox({
        title: "Greet someone",
        prompt: "A name to greet",
        placeHolder: "Ada",
        validateInput: (value) =>
          value.trim() ? undefined : "A name is required.",
      });
      if (!name) {
        return;
      }
      output.appendLine(`hi ${name.trim()}`);
      vscode.window.showInformationMessage(`Hi, ${name.trim()}.`);
    },
  );

  const pickRuntime = vscode.commands.registerCommand(
    "runtimecode.shell.pickRuntime",
    async () => {
      const picked = await vscode.window.showQuickPick(RUNTIMES, {
        title: "Pick a runtime",
        placeHolder: "Nothing is installed yet; this is a placeholder.",
        matchOnDescription: true,
        matchOnDetail: true,
      });
      if (!picked) {
        return;
      }
      vscode.window.showInformationMessage(`Selected ${picked.label}.`);
    },
  );

  const openPanel = vscode.commands.registerCommand(
    "runtimecode.shell.openPanel",
    () => {
      // A webview is an iframe the extension owns. enableScripts is what lets
      // the page talk back over postMessage. retainContextWhenHidden keeps the
      // page alive when its tab is backgrounded, which matters for anything
      // stateful.
      const panel = vscode.window.createWebviewPanel(
        "runtimecode.shell.panel",
        "Runtime Shell",
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.webview.html = panelHtml();
      panel.webview.onDidReceiveMessage((message) => {
        if (message && message.command === "ping") {
          panel.webview.postMessage({
            command: "pong",
            at: new Date().toLocaleTimeString(),
          });
        }
      });
      // Disposing the panel also disposes this subscription, so the message
      // handler above does not outlive the panel.
      context.subscriptions.push(panel);
    },
  );

  // Settings can change while the extension is running. This is where you pick
  // the change up; reading getConfiguration() again is what makes it take effect.
  const onConfigChanged = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (event.affectsConfiguration(`${CONFIG_SECTION}.greeting`)) {
        const greeting = vscode.workspace
          .getConfiguration(CONFIG_SECTION)
          .get("greeting", "world");
        output.appendLine(`greeting changed to "${greeting}"`);
      }
    },
  );

  // Anything disposable registered by activate() goes here, and VS Code
  // disposes it all when the extension unloads. Leaving a command out means it
  // survives a reload in a half-dead state.
  context.subscriptions.push(
    output,
    status,
    hello,
    greet,
    pickRuntime,
    openPanel,
    onConfigChanged,
  );
}

/**
 * The HTML for the panel. A real webview should also set a Content-Security-
 * Policy in a <meta> tag; this one is omitted only because there is nothing to
 * protect here. `acquireVsCodeApi` is injected by the host and is the only
 * channel from the page to the extension.
 *
 * @returns {string}
 */
function panelHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<style>
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 16px;
		}
		button {
			font: inherit; cursor: pointer; padding: 4px 10px; border: none; border-radius: 2px;
			color: var(--vscode-button-foreground);
			background: var(--vscode-button-background);
		}
		button:hover { background: var(--vscode-button-hoverBackground); }
		#log { margin-top: 12px; opacity: .8; }
	</style>
</head>
<body>
	<h2>Runtime Shell</h2>
	<p>This panel is HTML the extension supplied. Clicking the button sends a message into the extension host, which answers.</p>
	<button id="ping">Ping the extension</button>
	<div id="log"></div>
	<script>
		const api = acquireVsCodeApi();
		const log = document.getElementById('log');
		document.getElementById('ping').addEventListener('click', () => {
			log.textContent = 'waiting...';
			api.postMessage({ command: 'ping' });
		});
		window.addEventListener('message', (event) => {
			if (event.data && event.data.command === 'pong') {
				log.textContent = 'pong at ' + event.data.at;
			}
		});
	</script>
</body>
</html>`;
}

function deactivate() {
  // Every disposable above is already cleaned up by context.subscriptions.
  // deactivate() only exists for work that outlives the subscriptions.
}

module.exports = { activate, deactivate };
