/**
 * Build gate: catches Microsoft endpoints reappearing in the output.
 *
 * A plain grep is useless here — the build legitimately contains these strings
 * in localized UI text, in TypeScript's diagnostic messages, and as dead
 * fallbacks. So instead of failing on any match, this fails on any match that
 * is not in endpoint-allowlist.json with a written justification. That turns it
 * into drift detection: an upgrade that reintroduces a live endpoint shows up
 * as a new, unexplained hit.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { RC_ROOT, DIST } from './lib.mjs';

const PATTERNS = [
	'vscode-cdn.net',
	'marketplace.visualstudio.com',
	'aka.ms',
	'copilot_internal',
	'dc.services.visualstudio.com',
	'vortex.data.microsoft.com',
	'mobile.events.data.microsoft.com',
	'api.github.com/copilot',
	'default.exp-tas.com'
];

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css']);
/** Vendored dependencies are not ours to police and are full of doc-comment noise. */
const SKIP_DIRS = new Set(['node_modules', 'sourcemaps']);

const allowlist = JSON.parse(readFileSync(path.join(RC_ROOT, 'endpoint-allowlist.json'), 'utf8')).allow;

/** Supports a single `*` path segment, for the per-locale diagnostic message files. */
function matchesGlob(glob, file) {
	if (!glob.includes('*')) { return glob === file; }
	const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
	return new RegExp(`^${escaped}$`).test(file);
}

function isAllowed(pattern, file) {
	return allowlist.some(entry =>
		entry.pattern === pattern && entry.files.some(glob => matchesGlob(glob, file)));
}

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		let stat;
		try { stat = statSync(full); } catch { continue; }
		if (stat.isDirectory()) {
			if (SKIP_DIRS.has(entry)) { continue; }
			yield* walk(full);
		} else if (TEXT_EXT.has(path.extname(entry))) {
			yield full;
		}
	}
}

const unexplained = [];
const accountedFor = new Map();

for (const absolute of walk(DIST)) {
	let content;
	try { content = readFileSync(absolute, 'utf8'); } catch { continue; }
	const file = path.relative(DIST, absolute);

	for (const pattern of PATTERNS) {
		const index = content.indexOf(pattern);
		if (index === -1) { continue; }

		if (isAllowed(pattern, file)) {
			accountedFor.set(pattern, (accountedFor.get(pattern) ?? 0) + 1);
		} else {
			unexplained.push({
				file,
				pattern,
				context: content.slice(Math.max(0, index - 70), index + 70).replace(/\s+/g, ' ')
			});
		}
	}
}

for (const [pattern, count] of [...accountedFor].sort()) {
	console.log(`[check-endpoints] allowed: ${pattern} in ${count} file(s)`);
}

if (unexplained.length > 0) {
	console.error(`\n[check-endpoints] FAIL — ${unexplained.length} unexplained match(es):\n`);
	for (const hit of unexplained.slice(0, 30)) {
		console.error(`  ${hit.file}\n    ${hit.pattern}\n    ...${hit.context}...\n`);
	}
	if (unexplained.length > 30) { console.error(`  ...and ${unexplained.length - 30} more`); }
	console.error(
		'Either the endpoint is genuinely live (fix it), or it is inert — in which\n' +
		'case add it to endpoint-allowlist.json WITH a reason.\n'
	);
	process.exit(1);
}

console.log('[check-endpoints] OK — every match is accounted for');
