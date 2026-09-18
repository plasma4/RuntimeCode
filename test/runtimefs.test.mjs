/**
 * Tests for extensions/runtimefs/extension.js.
 *
 * Run them with: node --test test/
 *
 * Two things they are built to catch. First, breaking the rules the web
 * extension host imposes (single CommonJS file, 'vscode' the only resolvable
 * require). Second, breaking the rules RuntimeFS imposes, which are invisible
 * from inside the editor: the per-folder write lock, the registry lock, and the
 * cache invalidation without which a preview tab keeps serving the old file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadExtension, rfsFolder, settle, MANIFEST } from './harness.mjs';

const uri = (vscode, path) => vscode.Uri.from({ scheme: 'rfs', path });
const text = (bytes) => Buffer.from(bytes).toString('utf8');
const bytes = (value) => new Uint8Array(Buffer.from(value, 'utf8'));

// ---------------------------------------------------------------------------
// Loading rules
// ---------------------------------------------------------------------------

test('loads as CommonJS with vscode as its only dependency', () => {
	const { exports, requested } = loadExtension();

	assert.equal(typeof exports.activate, 'function');
	assert.equal(typeof exports.deactivate, 'function');
	assert.deepEqual([...new Set(requested)], ['vscode']);
});

test('activate registers the rfs provider and every command the manifest declares', () => {
	const { exports, vscode, commands, registered } = loadExtension();
	exports.activate({ subscriptions: [] });

	assert.equal(registered.fileSystemProvider.scheme, 'rfs');
	assert.equal(typeof registered.fileSystemProvider.provider.readFile, 'function');

	const declared = MANIFEST.contributes.commands.map(command => command.command).sort();
	assert.deepEqual([...commands.keys()].sort(), declared,
		'package.json and activate() disagree about which commands exist');

	// Keybindings and menus can only reference commands that are declared.
	const keybound = (MANIFEST.contributes.keybindings ?? []).map(binding => binding.command);
	const menued = Object.values(MANIFEST.contributes.menus ?? {}).flat().map(item => item.command);
	for (const command of [...keybound, ...menued]) {
		assert.ok(declared.includes(command), `${command} is bound but never declared`);
	}
	assert.ok(vscode);
});

// ---------------------------------------------------------------------------
// URI mapping
// ---------------------------------------------------------------------------

test('parseUri splits rfs: paths and decodes segments', () => {
	const { internals, vscode } = loadExtension();

	assert.deepEqual(internals.parseUri(uri(vscode, '/Site')), { folder: 'Site', parts: [] });
	assert.deepEqual(internals.parseUri(uri(vscode, '/Site/src/app.js')),
		{ folder: 'Site', parts: ['src', 'app.js'] });
	assert.deepEqual(internals.parseUri(uri(vscode, '/My%20Site/a%20b.txt')),
		{ folder: 'My Site', parts: ['a b.txt'] });

	assert.throws(() => internals.parseUri(uri(vscode, '/')), { code: 'FileNotFound' });
});

test('toFileSystemError maps OPFS failures onto what VS Code expects', () => {
	const { internals, vscode } = loadExtension();
	const target = uri(vscode, '/Site/a.txt');
	const as = (name) => internals.toFileSystemError(Object.assign(new Error('x'), { name }), target).code;

	assert.equal(as('NotFoundError'), 'FileNotFound');
	assert.equal(as('TypeMismatchError'), 'FileNotADirectory');
	assert.equal(as('InvalidModificationError'), 'FileExists');
	assert.equal(as('NoModificationAllowedError'), 'NoPermissions');
	assert.equal(as('NotAllowedError'), 'NoPermissions');

	// Anything else has to come through unchanged, or a real bug reads as ENOENT.
	const other = new Error('boom');
	assert.equal(internals.toFileSystemError(other, target), other);
});

// ---------------------------------------------------------------------------
// FileSystemProvider
// ---------------------------------------------------------------------------

async function provider(files = {}) {
	const invalidated = [];
	const loaded = loadExtension({
		hostCommands: {
			'runtimecode.internal.invalidateRfsCache': async (folder) => { invalidated.push(folder); return true; }
		}
	});
	await rfsFolder(loaded.opfs, 'Site', files);
	return { ...loaded, invalidated, fs: new loaded.internals.RuntimeFSProvider() };
}

test('reads, writes and stats files', async () => {
	const { fs, vscode } = await provider({ 'index.html': '<h1>hi</h1>', 'src/app.js': 'export {}' });

	assert.equal(text(await fs.readFile(uri(vscode, '/Site/index.html'))), '<h1>hi</h1>');
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/src/app.js'))), 'export {}');

	const stat = await fs.stat(uri(vscode, '/Site/index.html'));
	assert.equal(stat.type, vscode.FileType.File);
	assert.equal(stat.size, 11);

	assert.equal((await fs.stat(uri(vscode, '/Site/src'))).type, vscode.FileType.Directory);
	assert.equal((await fs.stat(uri(vscode, '/Site'))).type, vscode.FileType.Directory);

	await assert.rejects(fs.stat(uri(vscode, '/Site/missing.txt')), { code: 'FileNotFound' });
	await assert.rejects(fs.readFile(uri(vscode, '/Site/missing.txt')), { code: 'FileNotFound' });
});

test('readDirectory reports files and directories', async () => {
	const { fs, vscode } = await provider({ 'index.html': 'x', 'src/app.js': 'y', 'empty': null });

	const entries = await fs.readDirectory(uri(vscode, '/Site'));
	assert.deepEqual(entries.sort(), [
		['empty', vscode.FileType.Directory],
		['index.html', vscode.FileType.File],
		['src', vscode.FileType.Directory]
	].sort());
});

test('writeFile honours create and overwrite', async () => {
	const { fs, vscode } = await provider({ 'index.html': 'old' });

	await assert.rejects(
		fs.writeFile(uri(vscode, '/Site/new.txt'), bytes('x'), { create: false, overwrite: true }),
		{ code: 'FileNotFound' });
	await assert.rejects(
		fs.writeFile(uri(vscode, '/Site/index.html'), bytes('x'), { create: true, overwrite: false }),
		{ code: 'FileExists' });

	await fs.writeFile(uri(vscode, '/Site/index.html'), bytes('new'), { create: true, overwrite: true });
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/index.html'))), 'new');

	await fs.writeFile(uri(vscode, '/Site/deep/nested/file.txt'), bytes('made'), { create: true, overwrite: true });
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/deep/nested/file.txt'))), 'made');
});

test('writes take the RuntimeFS folder lock and invalidate its cache', async () => {
	const { fs, vscode, calls, invalidated } = await provider({ 'index.html': 'old' });

	await fs.writeFile(uri(vscode, '/Site/index.html'), bytes('new'), { create: true, overwrite: true });

	assert.ok(calls.locks.includes('rfs_write_Site'),
		'a write that skips rfs_write_<name> can interleave with RuntimeFS');
	assert.deepEqual(invalidated, ['Site'],
		'without invalidation the preview keeps serving the file that was just replaced');
});

test('file events are emitted, and coalesced', async () => {
	const { fs, vscode } = await provider({ 'index.html': 'old' });
	// Copied on arrival: the provider reuses and truncates its buffer after
	// firing, the way the workbench (a synchronous consumer) expects.
	const batches = [];
	fs.onDidChangeFile(events => batches.push([...events]));

	await fs.writeFile(uri(vscode, '/Site/a.txt'), bytes('1'), { create: true, overwrite: true });
	await fs.writeFile(uri(vscode, '/Site/b.txt'), bytes('2'), { create: true, overwrite: true });
	await settle();

	assert.equal(batches.length, 1, 'a bulk write should not produce one notification per file');
	assert.deepEqual(batches[0].map(event => event.type), [vscode.FileChangeType.Created, vscode.FileChangeType.Created]);

	await fs.writeFile(uri(vscode, '/Site/a.txt'), bytes('3'), { create: true, overwrite: true });
	await settle();
	assert.deepEqual(batches[1].map(event => event.type), [vscode.FileChangeType.Changed]);
});

test('delete removes entries but refuses the workspace root', async () => {
	const { fs, vscode, invalidated } = await provider({ 'index.html': 'x', 'src/app.js': 'y' });

	await assert.rejects(fs.delete(uri(vscode, '/Site'), { recursive: true }), { code: 'NoPermissions' },
		'deleting the folder itself belongs to the RuntimeFS UI, which owns the registry entry');

	await fs.delete(uri(vscode, '/Site/index.html'), { recursive: false });
	await assert.rejects(fs.stat(uri(vscode, '/Site/index.html')), { code: 'FileNotFound' });

	await fs.delete(uri(vscode, '/Site/src'), { recursive: true });
	assert.deepEqual(await fs.readDirectory(uri(vscode, '/Site')), []);
	assert.deepEqual(invalidated, ['Site', 'Site']);
});

test('rename copies then deletes, for files and whole trees', async () => {
	const { fs, vscode } = await provider({ 'a.txt': 'one', 'src/app.js': 'two', 'src/lib/util.js': 'three' });

	await fs.rename(uri(vscode, '/Site/a.txt'), uri(vscode, '/Site/b.txt'), { overwrite: false });
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/b.txt'))), 'one');
	await assert.rejects(fs.stat(uri(vscode, '/Site/a.txt')), { code: 'FileNotFound' });

	await fs.rename(uri(vscode, '/Site/src'), uri(vscode, '/Site/lib'), { overwrite: false });
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/lib/app.js'))), 'two');
	assert.equal(text(await fs.readFile(uri(vscode, '/Site/lib/lib/util.js'))), 'three');
	await assert.rejects(fs.stat(uri(vscode, '/Site/src')), { code: 'FileNotFound' });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('the registry is written under the same lock rfs.js uses', async () => {
	const { internals, calls, opfs } = loadExtension();

	await internals.updateRegistryEntry('Site', { encryptionType: null });
	assert.ok(calls.locks.includes('rfs_registry_lock'));

	const registry = await internals.readRegistry();
	assert.equal(registry.Site.encryptionType, null);
	assert.equal(typeof registry.Site.lastModified, 'number');

	// A second write must merge, not replace: rfs.js keeps its own keys here.
	await internals.updateRegistryEntry('Site', { headers: '* -> X: 1' });
	const merged = await internals.readRegistry();
	assert.equal(merged.Site.encryptionType, null);
	assert.equal(merged.Site.headers, '* -> X: 1');

	await internals.updateRegistryEntry('Site', null);
	assert.deepEqual(await internals.readRegistry(), {});
	assert.ok(opfs);
});

test('readRegistry survives a missing or corrupt rfs_system.json', async () => {
	const { internals, opfs } = loadExtension();

	assert.deepEqual(await internals.readRegistry(), {});

	const writable = await (await opfs.getFileHandle('rfs_system.json', { create: true })).createWritable();
	await writable.write('{ this is not json');
	await writable.close();

	assert.deepEqual(await internals.readRegistry(), {});
});

test('listFolders unions the registry with what is actually on disk', async () => {
	const { internals, opfs } = loadExtension();

	await rfsFolder(opfs, 'OnDisk');
	await internals.updateRegistryEntry('Registered', {});
	await internals.updateRegistryEntry('OnDisk', {});

	assert.deepEqual(await internals.listFolders(), ['OnDisk', 'Registered']);
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('isPreviewable accepts what Dev Preview can render', () => {
	const { internals, vscode } = loadExtension();
	const can = (path) => internals.isPreviewable(uri(vscode, path));

	assert.ok(can('/Site/index.html'));
	assert.ok(can('/Site/page.htm'));
	assert.ok(can('/Site/logo.svg'));
	assert.ok(can('/Site/README.md'));
	assert.ok(!can('/Site/app.js'));
	assert.ok(!can('/Site/notes.txt'));
});

test('previewUrlFor builds an encoded /n/ url', () => {
	const { internals, vscode } = loadExtension();

	assert.equal(
		internals.previewUrlFor('https://example.org/fs', uri(vscode, '/Site/index.html')),
		'https://example.org/fs/n/Site/index.html');
	assert.equal(
		internals.previewUrlFor('https://example.org/fs', uri(vscode, '/My Site/a b.html')),
		'https://example.org/fs/n/My%20Site/a%20b.html');
});

test('previewWrapperUrl carries the target, the inspector and the cache buster', () => {
	const { internals } = loadExtension();
	const base = 'https://example.org/fs/n/RC/';
	const target = 'https://example.org/fs/n/Site/index.html';

	const plain = new URL(internals.previewWrapperUrl(base, target, false));
	assert.equal(plain.pathname, '/fs/n/RC/rc-preview.html');
	assert.equal(plain.searchParams.get('target'), target);
	assert.equal(plain.searchParams.get('inspector'), null);
	assert.equal(plain.searchParams.get('__rc'), null);

	const inspected = new URL(internals.previewWrapperUrl(base, target, true, true));
	assert.equal(inspected.searchParams.get('inspector'), '1');
	assert.ok(Number(inspected.searchParams.get('__rc')) > 0,
		'without a cache buster the iframe replays whatever RuntimeFS cached');
});

test('Export Folder Locally offers the open folder first', async () => {
	const { exports, vscode, commands, calls, opfs } = loadExtension();
	for (const name of ['Alpha', 'Beta', 'Gamma']) { await rfsFolder(opfs, name); }

	vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.from({ scheme: 'rfs', path: '/Beta' }) }];
	exports.activate({ subscriptions: [] });
	await commands.get('runtimecode.exportRfsFolder')();

	const [kind, items] = calls.messages.at(-1);
	assert.equal(kind, 'quickPick');
	// showQuickPick cannot preselect, so order is the only way to say "this one".
	assert.deepEqual(items, ['Beta', 'Alpha', 'Gamma']);
});

test('escapeHtml closes the attribute-injection hole in the preview panel', () => {
	const { internals } = loadExtension();

	assert.equal(internals.escapeHtml('<img src="x" onerror=alert(1)>'),
		'&lt;img src=&quot;x&quot; onerror=alert(1)&gt;');
	assert.equal(internals.escapeHtml('a & b'), 'a &amp; b');
});

// ---------------------------------------------------------------------------
// Same-origin headers
// ---------------------------------------------------------------------------

test('hasSameOriginHeaders needs both COEP and COOP', () => {
	const { internals } = loadExtension();
	const { hasSameOriginHeaders } = internals;

	assert.ok(hasSameOriginHeaders(
		'* -> Cross-Origin-Embedder-Policy: require-corp\n* -> Cross-Origin-Opener-Policy: same-origin'));
	// Order, case and spacing are the user's business; RuntimeFS parses it loosely.
	assert.ok(hasSameOriginHeaders(
		'*  ->  cross-origin-opener-policy : same-origin\n*->Cross-Origin-Embedder-Policy:require-corp'));

	assert.ok(!hasSameOriginHeaders('* -> Cross-Origin-Embedder-Policy: require-corp'));
	assert.ok(!hasSameOriginHeaders('* -> Cross-Origin-Embedder-Policy: credentialless\n* -> Cross-Origin-Opener-Policy: same-origin'));
	assert.ok(!hasSameOriginHeaders(''));
	assert.ok(!hasSameOriginHeaders(undefined));
});

test('setSameOriginHeaders adds, removes, and never duplicates', async () => {
	const invalidated = [];
	const { internals } = loadExtension({
		hostCommands: {
			'runtimecode.internal.invalidateRfsCache': async (folder) => { invalidated.push(folder); return true; }
		}
	});
	await internals.updateRegistryEntry('Site', { headers: '* -> X-Custom: keep-me' });

	await internals.setSameOriginHeaders('Site', true);
	await internals.setSameOriginHeaders('Site', true);

	const headers = (await internals.readRegistry()).Site.headers;
	assert.ok(internals.hasSameOriginHeaders(headers));
	assert.equal(headers.split('\n').filter(line => /Embedder-Policy/.test(line)).length, 1,
		're-enabling must not stack duplicate header lines in the folder');
	assert.ok(headers.includes('* -> X-Custom: keep-me'), 'the user\'s own header lines have to survive');

	await internals.setSameOriginHeaders('Site', false);
	const after = (await internals.readRegistry()).Site.headers;
	assert.ok(!internals.hasSameOriginHeaders(after));
	assert.equal(after, '* -> X-Custom: keep-me');

	assert.deepEqual(invalidated, ['Site', 'Site', 'Site'],
		'a header change only takes effect once RuntimeFS drops the cached responses');
});
