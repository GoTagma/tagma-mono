const EXACT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function manifestObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readExactVersion(manifest, path, field, manifestPath) {
  let value = manifestObject(manifest);
  for (const segment of path) value = manifestObject(value)[segment];

  if (value === undefined || value === null || value === '') {
    throw new Error(`${manifestPath}: ${field} is missing`);
  }
  if (typeof value !== 'string' || !EXACT_SEMVER_RE.test(value)) {
    throw new Error(
      `${manifestPath}: ${field} must be pinned to an exact semantic version; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Keep the generated SDK types and the bundled native CLI on one exact release.
 * Returns the shared version when the contract is valid and throws a diagnostic
 * suitable for the dependency checker otherwise.
 */
export function validateOpencodeVersionContract({
  editorManifest,
  electronManifest,
  editorManifestPath = 'apps/editor/package.json',
  electronManifestPath = 'apps/electron/package.json',
}) {
  const sdkVersion = readExactVersion(
    editorManifest,
    ['dependencies', '@opencode-ai/sdk'],
    '@opencode-ai/sdk',
    editorManifestPath,
  );
  const bundledVersion = readExactVersion(
    electronManifest,
    ['tagma', 'bundledOpencodeVersion'],
    'tagma.bundledOpencodeVersion',
    electronManifestPath,
  );

  if (sdkVersion !== bundledVersion) {
    throw new Error(
      `OpenCode SDK/CLI version mismatch: ${editorManifestPath} has @opencode-ai/sdk=${JSON.stringify(sdkVersion)}, ` +
        `${electronManifestPath} has tagma.bundledOpencodeVersion=${JSON.stringify(bundledVersion)}`,
    );
  }
  return sdkVersion;
}
