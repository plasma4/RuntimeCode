/**
 * The pure core of the runtime pack pipeline (RUNTIMES.md M2).
 *
 * A pack is an unmodified upstream runtime plus the metadata the host reads:
 *
 *   packs/<id>/pack.json      the build-time definition, checked into the repo:
 *                             pinned asset URLs, versions, license, descriptor.
 *   dist/packs/<id>/          the build-time output: the assets, a generated
 *                             extension manifest, a pack.json the host probes,
 *                             and the upstream LICENSE.
 *   dist/packs/catalog.json   every built pack, for install-time digest checks.
 *
 * This module does no work on import and never touches the network, so the
 * tests can load it without a vscode checkout. scripts/packs.mjs is the CLI
 * that drives it.
 *
 * The pipeline follows the Eruda precedent in staticify.mjs: a pinned URL plus
 * a SHA-256, verified at build time, served from our own origin. The new rule
 * this file adds is that a pack whose digests are not all recorded is not
 * shippable -- an unpinned pack is a promise, not a build.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RC_ROOT } from "./lib.mjs";

/** A pack is one folder under packs/. */
export const PACKS_SRC = path.join(RC_ROOT, "packs");

/** SPDX ids are the only license language the pipeline understands. */
const SPDX_ID = /^[A-Za-z0-9.()+-]+(\s+(AND|OR)\s+[A-Za-z0-9.()+-]+)*$/;

/**
 * Validate one pack definition. Returns a list of problems; an empty list is a
 * valid pack. A malformed definition is refused at build time rather than
 * skipped, because a skipped pack is how a promised runtime silently vanishes.
 *
 * @param {any} pack
 * @param {string} [id] the expected id, for the directory-name cross-check
 * @returns {string[]}
 */
export function validatePack(pack, id) {
  const problems = [];
  if (!pack || typeof pack !== "object") {
    return ["pack.json is not an object"];
  }
  if (typeof pack.id !== "string" || !pack.id) {
    problems.push("id is missing");
  } else if (id && pack.id !== id) {
    problems.push(`id "${pack.id}" does not match the folder "${id}"`);
  }
  if (typeof pack.version !== "string" || !pack.version) {
    problems.push(`[${pack.id}] version is missing`);
  }
  if (!SPDX_ID.test(String(pack.license || ""))) {
    problems.push(`[${pack.id}] license "${pack.license}" is not a valid SPDX id`);
  }
  for (const field of ["engine", "summary", "homepage"]) {
    if (typeof pack[field] !== "string" || !pack[field]) {
      problems.push(`[${pack.id}] ${field} is missing`);
    }
  }
  if (!Array.isArray(pack.assets) || pack.assets.length === 0) {
    problems.push(`[${pack.id}] no assets`);
  } else {
    const seen = new Set();
    for (const asset of pack.assets) {
      if (!asset || typeof asset.name !== "string" || !asset.name) {
        problems.push(`[${pack.id}] an asset has no name`);
        continue;
      }
      if (seen.has(asset.name)) {
        problems.push(`[${pack.id}] duplicate asset "${asset.name}"`);
      }
      seen.add(asset.name);
      if (typeof asset.url !== "string" || !asset.url) {
        problems.push(`[${pack.id}] asset "${asset.name}" has no url`);
      }
      if (asset.sha256 !== undefined && asset.sha256 !== null && !/^[0-9a-f]{64}$/.test(asset.sha256)) {
        problems.push(`[${pack.id}] asset "${asset.name}" has an invalid sha256`);
      }
    }
  }
  return problems;
}

/** Is every asset pinned (or is the whole pack one archive that is)? */
export function isPinned(pack) {
  return (
    Array.isArray(pack.assets) &&
    pack.assets.every(
      (asset) => typeof asset.sha256 === "string" && /^[0-9a-f]{64}$/.test(asset.sha256),
    )
  );
}

/** The SHA-256 hex digest of a Buffer. */
export function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Total install bytes: the sum of the assets the pipeline will copy. The value
 * the host advertises before anything downloads.
 *
 * @param {any} pack
 * @returns {number}
 */
export function installBytesFor(pack) {
  return (pack.assets || []).reduce(
    (sum, asset) => sum + (Number.isFinite(asset.bytes) ? asset.bytes : 0),
    0,
  );
}

/**
 * The runtimecode.runtimes descriptor the generated extension contributes.
 * The shape must round-trip through the host's toDescriptor() (see
 * extensions/python-rc/extension.js), so the host reads a pack exactly the way
 * it reads the built-in placeholders.
 *
 * @param {any} pack
 * @returns {object}
 */
export function runtimeDescriptor(pack) {
  return {
    id: pack.id,
    displayName: pack.displayName || pack.id,
    languages: pack.languages || [],
    tier: pack.tier || "quick",
    engine: pack.engine,
    languageVersion: pack.languageVersion || "",
    site: pack.site || "worker",
    // The generated worker entry. A pack carries its own session.js, which is
    // what makes it a pack instead of a placeholder.
    worker: "./session.js",
    assets: "./assets/",
    pack: pack.id,
    installBytes: installBytesFor(pack),
    license: pack.license,
    homepage: pack.homepage,
    summary: pack.summary,
    requires: pack.requires,
    capabilities: pack.capabilities,
    isolatedCapabilities: pack.isolatedCapabilities,
  };
}

/**
 * The extension manifest generated for a pack. A pack is an extension so the
 * host's catalog scan (extensions.all[].packageJSON) can pick it up with no
 * host change -- this is the mechanism RUNTIMES.md "Distribution and install"
 * calls bootstrap registration, and it means the host does not have to ship a
 * list of packs.
 *
 * @param {any} pack
 * @returns {object}
 */
export function packPackageJson(pack) {
  return {
    name: `runtimecode-pack-${pack.id.replace(/\./g, "-")}`,
    displayName: pack.displayName || pack.id,
    description: `${pack.summary || "A RuntimeCode runtime pack."} Built from ${pack.version}.`,
    version: "1.0.0",
    publisher: "runtimecode",
    license: pack.license,
    engines: { vscode: "^1.137.0" },
    categories: ["Programming Languages", "Other"],
    browser: "./extension.js",
    activationEvents: [],
    capabilities: {
      virtualWorkspaces: true,
      untrustedWorkspaces: { supported: true },
    },
    contributes: {
      "runtimecode.runtimes": [runtimeDescriptor(pack)],
    },
  };
}

/**
 * The pack.json written next to the assets, which is what the host probes and
 * what install-time digest verification reads. Fields are a strict subset of
 * the definition: no URLs leave the build.
 *
 * @param {any} pack
 * @returns {object}
 */
export function packManifest(pack) {
  return {
    id: pack.id,
    version: pack.version,
    engine: pack.engine,
    license: pack.license,
    installBytes: installBytesFor(pack),
    assets: (pack.assets || []).map((asset) => ({
      name: asset.name,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
  };
}

/**
 * One row of dist/packs/catalog.json. The install command reads this to know
 * what is available, how big it is, what its digests must be, and which files
 * the pack folder carries.
 *
 * @param {any} pack
 * @returns {object}
 */
export function catalogEntry(pack) {
  return {
    id: pack.id,
    version: pack.version,
    engine: pack.engine,
    site: pack.site || "worker",
    tier: pack.tier || "quick",
    license: pack.license,
    homepage: pack.homepage,
    summary: pack.summary,
    installBytes: installBytesFor(pack),
    descriptor: runtimeDescriptor(pack),
    assets: (pack.assets || []).map((asset) => ({
      name: asset.name,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })),
    // Every file the pack folder ships, in the layout the pipeline emits it.
    // Install copies these and verifies the asset digests among them; the glue
    // files (package.json, extension.js, session.js, pack.json) are ours, not
    // the runtime's, so they need no digest.
    files: [
      "package.json",
      "extension.js",
      "session.js",
      "pack.json",
      ...(pack.assets || []).map((asset) => `assets/${asset.name}`),
    ],
  };
}

/**
 * Load and validate one pack definition from packs/<id>/pack.json.
 * @param {string} id
 * @param {string} [root]
 * @returns {any}
 */
export function readPackDefinition(id, root = PACKS_SRC) {
  const file = path.join(root, id, "pack.json");
  let pack;
  try {
    pack = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
  const problems = validatePack(pack, id);
  if (problems.length > 0) {
    throw new Error(`${file} is invalid:\n  ${problems.join("\n  ")}`);
  }
  return pack;
}