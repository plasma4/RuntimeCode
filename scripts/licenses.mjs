/**
 * Who licenses what, and why the answer has to be per-folder.
 *
 * RuntimeCode is MIT and intends to stay MIT. Extensions are the part of this
 * repo most likely to carry someone else's terms: a runtime pack is an
 * unmodified upstream interpreter plus a thin host, and the interesting ones
 * are GPL (see NEXT.md, "Licenses at a glance"). So the licensing model has to
 * let a GPL extension sit next to an MIT workbench without either one infecting
 * the other.
 *
 * The architecture already draws that line, and it draws it in the right place.
 * The web extension host loads an extension by reading one source file and
 * calling `new Function('module','exports','require', src)`
 * (extHostExtensionService.ts:87). Extensions are never linked into
 * workbench.web.main.js, never bundled with it, and never share a compilation
 * unit with it. That is mere aggregation, which is the shape that keeps the host
 * MIT no matter what an extension is licensed under.
 *
 * What the build has to do is keep that boundary *visible*. A license that lives
 * only in this repo's root does not travel with the artifact, and an extension
 * whose terms are implied rather than stated is a compliance problem that
 * surfaces only after distribution, when it is expensive. So:
 *
 *   - every shipped extension declares an SPDX id in its package.json,
 *   - every shipped extension carries its own LICENSE file in its own folder,
 *   - both travel into dist/ unchanged, beside the code they cover,
 *   - copyleft extensions additionally say where the corresponding source is.
 *
 * This module is pure and does no work on import, so the tests can load it
 * without a vscode checkout. scripts/check-licenses.mjs is the gate that runs it
 * against a real build.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Accepted names for an extension's own license file, in preference order.
 * `LICENSE` is what we write; the rest are what a vendored upstream might
 * already have, and renaming someone's license file is a bad habit to build.
 */
export const LICENSE_FILENAMES = [
  "LICENSE",
  "LICENSE.txt",
  "LICENSE.md",
  "COPYING",
  "COPYING.txt",
];

/**
 * Dev-time files that live in an extension folder but have no business in the
 * artifact. `jsconfig.json` drives scripts/typecheck.mjs, `node_modules` is not
 * how the web extension host resolves anything, and `.DS_Store` is noise that
 * Finder scatters. Before this list existed the build copied `extensions/`
 * wholesale, which shipped 728 KB of gitignored `types/vscode.d.ts` to every
 * user.
 */
export const NON_SHIPPING_ENTRIES = new Set([
  "jsconfig.json",
  "tsconfig.json",
  "node_modules",
  ".DS_Store",
]);

/**
 * SPDX ids grouped by the only distinction that changes what the build must do.
 *
 * Permissive costs a retained notice. Weak copyleft adds a per-file source
 * obligation that an unmodified vendored asset satisfies by construction.
 * Strong copyleft adds a corresponding-source obligation that somebody has to
 * have actually thought about, which is why `sourceRequirement` exists below.
 *
 * Prefix matching, because the version suffixes multiply (`GPL-2.0-only`,
 * `GPL-3.0-or-later`, `LGPL-2.1+`) and the class never depends on them.
 */
const LICENSE_CLASSES = [
  ["strong-copyleft", ["AGPL-", "GPL-"]],
  ["weak-copyleft", ["LGPL-", "MPL-", "EPL-", "CDDL-", "CeCILL"]],
  [
    "permissive",
    [
      "MIT",
      "Apache-",
      "BSD-",
      "0BSD",
      "ISC",
      "Unlicense",
      "Zlib",
      "PSF-",
      "Python-",
      "CC0-",
      "BlueOak-",
    ],
  ],
];

/**
 * Classifies one SPDX id. Order matters: `LGPL-` and `AGPL-` both contain
 * `GPL-`, so the strong-copyleft prefixes are matched against the *start* of
 * the id and LGPL is listed separately rather than being caught by `GPL-`.
 *
 * An id we do not recognise returns "unknown" rather than a guess, and the gate
 * treats that as a failure. Guessing here would be the one bug in this file
 * nobody notices until it matters.
 */
export function classifySpdx(spdx) {
  if (typeof spdx !== "string" || spdx.trim() === "") {
    return "unknown";
  }
  const id = spdx.trim();
  for (const [name, prefixes] of LICENSE_CLASSES) {
    if (prefixes.some((prefix) => id.startsWith(prefix))) {
      return name;
    }
  }
  return "unknown";
}

/** Strong copyleft has to answer "where is the source?"; nothing else does. */
export function sourceRequirement(spdx) {
  return classifySpdx(spdx) === "strong-copyleft" ? "required" : "optional";
}

/**
 * An extension is a directory under `extensions/` with a `package.json`. That is
 * the whole rule, and it is deliberately the same rule the extension host uses,
 * so a folder cannot be shipped without also being declarable. `types/`, which
 * holds the gitignored `vscode.d.ts`, has no manifest and is therefore not an
 * extension and not shipped.
 */
export function listExtensionDirs(extensionsRoot) {
  if (!existsSync(extensionsRoot)) {
    return [];
  }
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(path.join(extensionsRoot, name, "package.json")),
    )
    .sort();
}

/** The extension's own license file, or null when it has none. */
export function findLicenseFile(dir) {
  return (
    LICENSE_FILENAMES.find((name) => existsSync(path.join(dir, name))) ?? null
  );
}

/**
 * Reads one extension's licensing facts. Returns an entry plus the problems
 * found with it, rather than throwing: the gate wants to report every broken
 * extension at once, not the first one alphabetically.
 */
export function readExtensionLicense(extensionsRoot, id) {
  const dir = path.join(extensionsRoot, id);
  const problems = [];

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch (error) {
    return {
      entry: { id, spdx: null, class: "unknown", licenseFile: null },
      problems: [`${id}: package.json is not readable JSON (${error.message})`],
    };
  }

  const spdx = typeof manifest.license === "string" ? manifest.license : null;
  const klass = classifySpdx(spdx);
  if (!spdx) {
    problems.push(
      `${id}: package.json has no "license" field. Every shipped extension ` +
        `states its own terms; the root MIT license does not reach into this folder.`,
    );
  } else if (klass === "unknown") {
    problems.push(
      `${id}: "${spdx}" is not an SPDX id this build recognises. Add it to ` +
        `LICENSE_CLASSES in scripts/licenses.mjs once you have decided which ` +
        `class it belongs to, rather than letting the build assume.`,
    );
  }

  const licenseFile = findLicenseFile(dir);
  if (!licenseFile) {
    problems.push(
      `${id}: no license file. Expected one of ${LICENSE_FILENAMES.join(", ")} ` +
        `in extensions/${id}/, so the terms travel with the code into dist/.`,
    );
  }

  // GPL and AGPL oblige the distributor to offer the corresponding source. Our
  // own extensions satisfy that trivially, because the web extension host cannot
  // load a bundle and the folder we ship *is* the source; "in-tree" records that
  // as a decision. A pack that vendors an upstream wasm binary does not, and has
  // to name where that binary's source lives.
  const source = manifest.runtimecode?.source ?? null;
  if (sourceRequirement(spdx) === "required" && !source) {
    problems.push(
      `${id}: ${spdx} obliges an offer of corresponding source, so the manifest ` +
        `needs "runtimecode": { "source": ... } — a URL to the exact upstream ` +
        `revision, or "in-tree" when the shipped folder is the complete source.`,
    );
  }

  return {
    entry: {
      id,
      name: manifest.displayName ?? manifest.name ?? id,
      version: manifest.version ?? null,
      spdx,
      class: klass,
      licenseFile,
      source,
    },
    problems,
  };
}

/**
 * Every shipped extension's licensing facts, plus every problem across all of
 * them. Callers decide whether problems are fatal; staticify and check-licenses
 * both treat them as fatal, at different points in the build.
 */
export function collectExtensionLicenses(extensionsRoot) {
  const entries = [];
  const problems = [];
  for (const id of listExtensionDirs(extensionsRoot)) {
    const result = readExtensionLicense(extensionsRoot, id);
    entries.push(result.entry);
    problems.push(...result.problems);
  }
  return { entries, problems };
}

/** How a source offer reads in the generated index. */
function describeSource(entry) {
  if (!entry.source) {
    return "";
  }
  return entry.source === "in-tree"
    ? " Complete corresponding source is this folder, shipped unbundled."
    : ` Corresponding source: ${entry.source}`;
}

/**
 * The compliance artifact: one index, written beside the extensions it
 * describes, naming each extension's terms and pointing at the file that states
 * them. A reader who downloaded only `dist/app/` can answer "what am I allowed
 * to do with this?" without leaving the folder.
 */
export function renderLicenseIndex(entries) {
  const lines = [
    "# Extension licenses",
    "",
    "Each folder here is a separate work with its own terms. The workbench they",
    "load into is MIT; an extension is not, unless its own license says so.",
    "",
    "The web extension host loads each of these by reading one source file and",
    "calling `new Function(...)`, so no extension is linked into or bundled with",
    "the workbench. They are aggregated, not combined.",
    "",
  ];

  if (entries.length === 0) {
    lines.push("No extensions are shipped in this build.", "");
    return lines.join("\n");
  }

  lines.push("| Extension | License | Full text |", "| --- | --- | --- |");
  for (const entry of entries) {
    lines.push(
      `| ${entry.name} (\`${entry.id}\`) | ${entry.spdx} | [\`${entry.id}/${entry.licenseFile}\`](${entry.id}/${entry.licenseFile}) |`,
    );
  }
  lines.push("");

  const copyleft = entries.filter((entry) => entry.class !== "permissive");
  if (copyleft.length > 0) {
    lines.push("## Source offers", "");
    for (const entry of copyleft) {
      lines.push(`- \`${entry.id}\` (${entry.spdx}).${describeSource(entry)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * The same facts as plain text, for the single ThirdPartyNotices.txt that ships
 * at the root of the app. Duplication is the point: a notices file nobody can
 * find is not a notice.
 */
export function renderExtensionNotices(entries) {
  if (entries.length === 0) {
    return "No RuntimeCode extensions are shipped in this build.";
  }
  return entries
    .map((entry) => {
      const version = entry.version ? ` ${entry.version}` : "";
      return (
        `${entry.name}${version} (rc-extensions/${entry.id}) — ${entry.spdx}\n` +
        `    Full text: rc-extensions/${entry.id}/${entry.licenseFile}` +
        (entry.source ? `\n   ${describeSource(entry).trimEnd()}` : "")
      );
    })
    .join("\n\n");
}
