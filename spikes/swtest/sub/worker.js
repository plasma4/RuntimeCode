// Runs inside the iframe, standing in for the web extension host worker.
// It must (a) reach OPFS at all, (b) see the folder RuntimeFS created, and
// (c) be able to write back into it.

const RFS_PREFIX = 'rfs';
const FOLDER = 'SwSpike';

(async () => {
	try {
		if (!navigator.storage?.getDirectory) {
			postMessage({ ok: false, error: 'no OPFS in worker' });
			return;
		}

		const root = await navigator.storage.getDirectory();
		const rfsRoot = await root.getDirectoryHandle(RFS_PREFIX);
		const folder = await rfsRoot.getDirectoryHandle(FOLDER);

		// (b) read the marker RuntimeFS's side wrote
		const marker = await (await (await folder.getFileHandle('marker.txt')).getFile()).text();

		// (c) write back, the way the filesystem provider will
		const stamp = 'worker-wrote-' + Date.now();
		const wh = await folder.getFileHandle('from-worker.txt', { create: true });
		const writable = await wh.createWritable();
		await writable.write(stamp);
		await writable.close();

		// Also confirm the registry file is visible from here.
		let registryOk = false;
		try {
			const sys = await (await (await root.getFileHandle('rfs_system.json')).getFile()).text();
			registryOk = JSON.parse(sys)[FOLDER] !== undefined;
		} catch { /* reported as false */ }

		postMessage({
			ok: marker.includes('MARKER-OK'),
			marker: marker.slice(0, 40),
			wroteBack: stamp,
			registryVisible: registryOk
		});
	} catch (err) {
		postMessage({ ok: false, error: String(err) });
	}
})();
