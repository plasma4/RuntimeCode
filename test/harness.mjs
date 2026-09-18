/**
 * Loads extensions/runtimefs/extension.js the way the web extension host loads
 * it: one CommonJS source string, wrapped in `new Function`, with `require`
 * resolving nothing but 'vscode' (extHostExtensionService.ts:87 and :109).
 *
 * Running the real loader is the point. A test that imported the file as a
 * module would pass on code the browser refuses, which is the only failure mode
 * that matters for an unbundled web extension.
 *
 * The browser globals the extension touches (navigator, setTimeout) are passed
 * as extra parameters rather than assigned onto globalThis, so the fakes are
 * scoped to the loaded extension and cannot leak between tests.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION = path.join(RC_ROOT, 'extensions', 'runtimefs', 'extension.js');

export const MANIFEST = JSON.parse(
	readFileSync(path.join(RC_ROOT, 'extensions', 'runtimefs', 'package.json'), 'utf8')
);

/**
 * Internals the tests reach for. The epilogue runs inside the extension's own
 * function scope, so a rename upstream in the file fails loudly here instead of
 * silently testing nothing.
 */
const INTERNALS = [
	'parseUri', 'toFileSystemError', 'errorName', 'isPreviewable', 'previewUrlFor',
	'previewWrapperUrl', 'hasSameOriginHeaders', 'setSameOriginHeaders',
	'readRegistry', 'updateRegistryEntry', 'listFolders', 'escapeHtml',
	'RuntimeFSProvider'
];

// ---------------------------------------------------------------------------
// Fake OPFS
// ---------------------------------------------------------------------------

function domError(name, message) {
	const error = new Error(message);
	error.name = name;
	return error;
}

class FakeFileHandle {
	kind = 'file';

	constructor(name, store) {
		this.name = name;
		this._store = store;		// { data: Uint8Array, lastModified: number }
	}

	async getFile() {
		const { data, lastModified } = this._store;
		return {
			size: data.byteLength,
			lastModified,
			async arrayBuffer() { return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); },
			async text() { return Buffer.from(data).toString('utf8'); }
		};
	}

	async createWritable() {
		const chunks = [];
		const store = this._store;
		return {
			async write(chunk) {
				chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
			},
			async close() {
				store.data = new Uint8Array(Buffer.concat(chunks));
				store.lastModified = Date.now();
			}
		};
	}
}

class FakeDirectoryHandle {
	kind = 'directory';

	constructor(name = '') {
		this.name = name;
		this._children = new Map();	// name -> FakeDirectoryHandle | { data, lastModified }
	}

	async getDirectoryHandle(name, options = {}) {
		const existing = this._children.get(name);
		if (existing instanceof FakeDirectoryHandle) { return existing; }
		if (existing) { throw domError('TypeMismatchError', `${name} is a file`); }
		if (!options.create) { throw domError('NotFoundError', `${name} not found`); }

		const created = new FakeDirectoryHandle(name);
		this._children.set(name, created);
		return created;
	}

	async getFileHandle(name, options = {}) {
		const existing = this._children.get(name);
		if (existing instanceof FakeDirectoryHandle) { throw domError('TypeMismatchError', `${name} is a directory`); }
		if (existing) { return new FakeFileHandle(name, existing); }
		if (!options.create) { throw domError('NotFoundError', `${name} not found`); }

		const store = { data: new Uint8Array(), lastModified: Date.now() };
		this._children.set(name, store);
		return new FakeFileHandle(name, store);
	}

	async removeEntry(name, options = {}) {
		const existing = this._children.get(name);
		if (!existing) { throw domError('NotFoundError', `${name} not found`); }
		if (existing instanceof FakeDirectoryHandle && existing._children.size && !options.recursive) {
			throw domError('InvalidModificationError', `${name} is not empty`);
		}
		this._children.delete(name);
	}

	async *entries() {
		for (const [name, value] of [...this._children]) {
			yield [name, value instanceof FakeDirectoryHandle ? value : new FakeFileHandle(name, value)];
		}
	}
}

/** Walks or builds `rfs/<Folder>/<path>` so a test can arrange a tree in one line. */
export async function seed(root, files) {
	for (const [filePath, contents] of Object.entries(files)) {
		const parts = filePath.split('/').filter(Boolean);
		let dir = root;
		for (const part of parts.slice(0, -1)) {
			dir = await dir.getDirectoryHandle(part, { create: true });
		}
		const last = parts[parts.length - 1];
		if (contents === null) {
			await dir.getDirectoryHandle(last, { create: true });
			continue;
		}
		const writable = await (await dir.getFileHandle(last, { create: true })).createWritable();
		await writable.write(contents);
		await writable.close();
	}
	return root;
}

// ---------------------------------------------------------------------------
// Fake vscode
// ---------------------------------------------------------------------------

class Uri {
	constructor(scheme, uriPath) {
		this.scheme = scheme;
		this.path = uriPath;
	}

	static from({ scheme, path: uriPath }) { return new Uri(scheme, uriPath); }

	static parse(value) {
		const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value);
		if (!match) { throw new Error(`not a uri: ${value}`); }
		return new Uri(match[1], match[2]);
	}

	with(change) { return new Uri(change.scheme ?? this.scheme, change.path ?? this.path); }
	toString() { return `${this.scheme}:${this.path}`; }
}

class FakeEventEmitter {
	constructor() {
		this.listeners = [];
		this.event = (listener) => {
			this.listeners.push(listener);
			return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
		};
	}

	fire(value) {
		for (const listener of [...this.listeners]) { listener(value); }
	}
}

function fsError(code) {
	return (uriOrMessage) => {
		const error = new Error(String(uriOrMessage));
		error.code = code;
		error.name = code;
		return error;
	};
}

/**
 * @param {object} options
 * @param {Record<string, Function>} [options.hostCommands] embedder commands the
 *   bootstrap registers in static/index.html, which the extension can only reach
 *   through executeCommand.
 * @param {Record<string, unknown>} [options.answers] canned replies, keyed by the
 *   window API that asks the question.
 */
export function createVscodeStub({ hostCommands = {}, answers = {} } = {}) {
	const calls = { executed: [], messages: [], locks: [], configUpdates: [] };
	const commands = new Map();
	const configuration = new Map();
	const listeners = { configuration: [], save: [] };
	// A mutable box rather than a getter, so tests can destructure the result
	// before activate() has run and still see the registration afterwards.
	const registered = { fileSystemProvider: undefined };

	const vscode = {
		Uri,
		EventEmitter: FakeEventEmitter,
		Disposable: class Disposable {
			constructor(fn) { this.dispose = fn ?? (() => { }); }
		},
		FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
		FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
		ViewColumn: { Active: -1, Beside: -2, One: 1 },
		FileSystemError: {
			FileNotFound: fsError('FileNotFound'),
			FileExists: fsError('FileExists'),
			FileNotADirectory: fsError('FileNotADirectory'),
			FileIsADirectory: fsError('FileIsADirectory'),
			NoPermissions: fsError('NoPermissions')
		},

		commands: {
			registerCommand(id, handler) {
				commands.set(id, handler);
				return { dispose: () => commands.delete(id) };
			},
			async executeCommand(id, ...args) {
				calls.executed.push([id, ...args]);
				const handler = hostCommands[id] ?? commands.get(id);
				if (!handler) { throw new Error(`command not found: ${id}`); }
				return handler(...args);
			}
		},

		window: {
			activeTextEditor: undefined,
			async showInformationMessage(message) { calls.messages.push(['info', message]); return answers.information; },
			async showWarningMessage(message) { calls.messages.push(['warning', message]); return answers.warning; },
			async showErrorMessage(message) { calls.messages.push(['error', message]); return answers.error; },
			async showQuickPick(items) { calls.messages.push(['quickPick', items]); return answers.quickPick; },
			async showInputBox(options) { calls.messages.push(['inputBox', options]); return answers.inputBox; },
			createWebviewPanel() {
				return {
					title: '',
					webview: { html: '', onDidReceiveMessage() { }, postMessage() { } },
					onDidDispose() { },
					reveal() { }
				};
			}
		},

		workspace: {
			workspaceFolders: undefined,
			registerFileSystemProvider(scheme, provider) {
				registered.fileSystemProvider = { scheme, provider };
				return { dispose() { } };
			},
			getConfiguration(section) {
				return {
					get: (key, fallback) => configuration.has(`${section}.${key}`) ? configuration.get(`${section}.${key}`) : fallback,
					update: async (key, value) => {
						configuration.set(`${section}.${key}`, value);
						calls.configUpdates.push([`${section}.${key}`, value]);
					}
				};
			},
			onDidChangeConfiguration(listener) { listeners.configuration.push(listener); return { dispose() { } }; },
			onDidSaveTextDocument(listener) { listeners.save.push(listener); return { dispose() { } }; },
			async saveAll() { return true; }
		}
	};

	return { vscode, calls, commands, configuration, listeners, registered };
}

// ---------------------------------------------------------------------------

/** Loads the extension against fresh fakes and returns everything a test needs. */
export function loadExtension(options = {}) {
	const stub = createVscodeStub(options);
	const opfs = new FakeDirectoryHandle();

	const navigator = {
		storage: { getDirectory: async () => opfs },
		locks: {
			async request(name, optionsOrFn, maybeFn) {
				stub.calls.locks.push(name);
				return (typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn)();
			}
		}
	};

	const source = readFileSync(EXTENSION, 'utf8');
	const epilogue = `\n;module.exports.__internals = { ${INTERNALS.join(', ')} };\n`;
	const factory = new Function('module', 'exports', 'require', 'navigator', 'setTimeout', 'clearTimeout',
		source + epilogue);

	const requested = [];
	const module = { exports: {} };
	factory(module, module.exports, (request) => {
		requested.push(request);
		if (request !== 'vscode') { throw new Error(`Cannot load module '${request}'`); }
		return stub.vscode;
	}, navigator, setTimeout, clearTimeout);

	return { ...stub, opfs, exports: module.exports, internals: module.exports.__internals, requested };
}

/** Test-side mirror of the rfs: mapping, for arranging fixtures. */
export async function rfsFolder(opfs, name, files = {}) {
	const rfs = await opfs.getDirectoryHandle('rfs', { create: true });
	return seed(await rfs.getDirectoryHandle(name, { create: true }), files);
}

/** `_fireSoon` coalesces on a 5ms timer. */
export const settle = () => new Promise(resolve => setTimeout(resolve, 20));
