'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

const RELEASE_FILES = Object.freeze([
  'background.js',
  'backgroundClient.js',
  'blocked.css',
  'blocked.html',
  'blocked.js',
  'controlPanel.css',
  'controlPanel.html',
  'controlPanel.js',
  'extensionIcon.png',
  'lockShared.js',
  'manifest.json',
  'options.css',
  'options.html',
  'options.js',
  'playerOverlay.js',
  'playerShortcuts.js',
  'redirect.js',
  'runtimeContracts.js',
  'runtimeCore.js',
  'searchOverlay.css',
  'searchOverlay.js',
  'storageSchema.js'
]);

const RUNTIME_FILE_PATTERN = /\.(?:css|html?|jpe?g|js|json|png|svg|webp|woff2?)$/i;
const DANGEROUS_FILE_PATTERNS = [
  /(^|\/)\.git(?:\/|$)/i,
  /(^|\/)\.env(?:\.|\/|$)/i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)node_modules(?:\/|$)/i,
  /(^|\/)(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /\.(?:key|p12|pfx|pem)$/i
];
const REMOTE_SCHEME_PATTERN = /^(?:https?:|data:|blob:|javascript:|\/\/)/i;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function assertValid(condition, message) {
  if (!condition) {
    throw new ValidationError(message);
  }
}

function isDangerousPath(relativePath) {
  return DANGEROUS_FILE_PATTERNS.some((pattern) => pattern.test(relativePath));
}

function normalizeReference(rawReference, owner, options = {}) {
  assertValid(
    typeof rawReference === 'string' && rawReference.trim(),
    `${owner} contains an empty runtime reference.`
  );

  const reference = rawReference.trim();
  assertValid(
    !REMOTE_SCHEME_PATTERN.test(reference),
    `${owner} contains a forbidden remote or executable reference: ${reference}`
  );
  assertValid(
    !/^[a-z][a-z0-9+.-]*:/i.test(reference),
    `${owner} contains an unsupported URL scheme: ${reference}`
  );
  assertValid(
    !reference.includes('\\'),
    `${owner} must use POSIX paths: ${reference}`
  );

  const withoutSuffix = reference.split(/[?#]/, 1)[0];
  if (options.allowRoot && (withoutSuffix === '/' || withoutSuffix === '')) {
    return null;
  }

  const withoutLeadingSlash = options.allowLeadingSlash
    ? withoutSuffix.replace(/^\/+/, '')
    : withoutSuffix;
  assertValid(
    withoutLeadingSlash === withoutSuffix || options.allowLeadingSlash,
    `${owner} contains an absolute path: ${reference}`
  );

  const normalized = path.posix.normalize(withoutLeadingSlash);
  assertValid(
    normalized &&
      normalized !== '.' &&
      normalized !== '..' &&
      !normalized.startsWith('../') &&
      !path.posix.isAbsolute(normalized),
    `${owner} escapes the extension root: ${reference}`
  );
  assertValid(
    !isDangerousPath(normalized),
    `${owner} references a forbidden file: ${normalized}`
  );
  return normalized;
}

function addReference(references, rawReference, owner, options) {
  const normalized = normalizeReference(rawReference, owner, options);
  if (normalized) references.add(normalized);
}

function addIconReferences(references, value, owner) {
  if (typeof value === 'string') {
    addReference(references, value, owner);
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  Object.values(value).forEach((iconPath) => {
    addReference(references, iconPath, owner);
  });
}

function collectManifestReferences(manifest) {
  const references = new Set();

  assertValid(manifest && typeof manifest === 'object', 'manifest.json must contain an object.');
  assertValid(manifest.manifest_version === 3, 'Only Manifest V3 is accepted.');
  assertValid(
    typeof manifest.name === 'string' && manifest.name.trim(),
    'manifest.json must define a non-empty name.'
  );
  assertValid(
    typeof manifest.version === 'string' &&
      /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(manifest.version),
    'manifest.json contains an invalid extension version.'
  );
  assertValid(
    manifest.minimum_chrome_version === '102',
    'manifest.json must retain the reviewed minimum Chrome version of 102.'
  );

  if (manifest.background && manifest.background.service_worker) {
    addReference(
      references,
      manifest.background.service_worker,
      'manifest.background.service_worker'
    );
  }

  for (const [index, contentScript] of (manifest.content_scripts || []).entries()) {
    for (const scriptPath of contentScript.js || []) {
      addReference(references, scriptPath, `manifest.content_scripts[${index}].js`);
    }
    for (const stylePath of contentScript.css || []) {
      addReference(references, stylePath, `manifest.content_scripts[${index}].css`);
    }
  }

  if (manifest.action) {
    if (manifest.action.default_popup) {
      addReference(references, manifest.action.default_popup, 'manifest.action.default_popup');
    }
    addIconReferences(references, manifest.action.default_icon, 'manifest.action.default_icon');
  }

  if (manifest.options_page) {
    addReference(references, manifest.options_page, 'manifest.options_page');
  }
  if (manifest.options_ui && manifest.options_ui.page) {
    addReference(references, manifest.options_ui.page, 'manifest.options_ui.page');
  }
  if (manifest.devtools_page) {
    addReference(references, manifest.devtools_page, 'manifest.devtools_page');
  }
  if (manifest.side_panel && manifest.side_panel.default_path) {
    addReference(references, manifest.side_panel.default_path, 'manifest.side_panel.default_path');
  }

  addIconReferences(references, manifest.icons, 'manifest.icons');

  for (const [index, overridePath] of Object.values(manifest.chrome_url_overrides || {}).entries()) {
    addReference(references, overridePath, `manifest.chrome_url_overrides[${index}]`);
  }

  for (const [index, ruleSet] of (manifest.declarative_net_request &&
    manifest.declarative_net_request.rule_resources || []).entries()) {
    addReference(references, ruleSet.path, `manifest.declarative_net_request.rule_resources[${index}]`);
  }

  for (const [groupIndex, group] of (manifest.web_accessible_resources || []).entries()) {
    for (const [resourceIndex, resource] of (group.resources || []).entries()) {
      assertValid(
        !/[*?[\]{}]/.test(resource),
        `manifest.web_accessible_resources[${groupIndex}].resources[${resourceIndex}] must be a literal allowlisted path.`
      );
      addReference(
        references,
        resource,
        `manifest.web_accessible_resources[${groupIndex}].resources[${resourceIndex}]`
      );
    }
  }

  const extensionPagesCsp = typeof manifest.content_security_policy === 'string'
    ? manifest.content_security_policy
    : manifest.content_security_policy && manifest.content_security_policy.extension_pages;
  if (extensionPagesCsp) {
    assertValid(
      !/(?:'unsafe-eval'|'unsafe-inline'|https?:|data:|\*)/i.test(extensionPagesCsp),
      'Extension-page CSP must not enable remote, inline, wildcard, or eval-based code.'
    );
  }

  return references;
}

function collectHtmlReferences(source, owner) {
  const references = new Set();
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;

  while ((match = scriptPattern.exec(source))) {
    const attributes = match[1];
    const body = match[2].trim();
    const srcMatch = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(attributes);
    assertValid(
      !/\bsrc\s*=/i.test(attributes) || Boolean(srcMatch),
      `${owner} script src attributes must use a quoted literal path.`
    );
    assertValid(
      Boolean(srcMatch) || body === '',
      `${owner} contains forbidden inline script code.`
    );
    if (srcMatch) {
      assertValid(body === '', `${owner} mixes a script src with inline code.`);
      addReference(references, srcMatch[2], `${owner} <script src>`);
    }
  }

  const resourceTagPattern = /<(?:link|img|source|iframe)\b[^>]*>/gi;
  while ((match = resourceTagPattern.exec(source))) {
    const attributeMatch = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/i.exec(match[0]);
    assertValid(
      !/\b(?:href|src)\s*=/i.test(match[0]) || Boolean(attributeMatch),
      `${owner} resource attributes must use quoted literal paths.`
    );
    if (attributeMatch) {
      addReference(references, attributeMatch[2], `${owner} resource tag`);
    }
  }

  assertValid(
    !/\son[a-z]+\s*=/i.test(source),
    `${owner} contains a forbidden inline event handler.`
  );
  assertValid(
    !/javascript\s*:/i.test(source),
    `${owner} contains a forbidden javascript: URL.`
  );

  return references;
}

function collectCssReferences(source, owner) {
  const references = new Set();
  let match;

  const importPattern = /@import\s+(?:url\(\s*)?(["'])(.*?)\1\s*\)?/gi;
  while ((match = importPattern.exec(source))) {
    addReference(references, match[2], `${owner} @import`);
  }

  const urlPattern = /\burl\(\s*(?:(["'])(.*?)\1|([^)'"\s]+))\s*\)/gi;
  while ((match = urlPattern.exec(source))) {
    const value = match[2] || match[3];
    if (value.startsWith('#')) continue;
    addReference(references, value, `${owner} url()`);
  }

  return references;
}

function collectJavaScriptReferences(source, owner) {
  const references = new Set();
  let match;

  assertValid(
    !/(^|[^\w$.])eval\s*\(/m.test(source),
    `${owner} contains forbidden eval().`
  );
  assertValid(
    !/\bnew\s+Function\s*\(/m.test(source),
    `${owner} contains forbidden new Function().`
  );
  assertValid(
    !/\bdocument\.(?:write|writeln)\s*\(/m.test(source),
    `${owner} contains forbidden document.write().`
  );

  const importScriptsPattern = /\bimportScripts\s*\(([^)]*)\)/g;
  while ((match = importScriptsPattern.exec(source))) {
    const argumentsSource = match[1];
    const stringPattern = /(["'])(.*?)\1/g;
    let stringMatch;
    let consumed = '';
    while ((stringMatch = stringPattern.exec(argumentsSource))) {
      consumed += stringMatch[0];
      addReference(references, stringMatch[2], `${owner} importScripts()`);
    }
    const remainder = argumentsSource
      .replace(/(["'])(.*?)\1/g, '')
      .replace(/[\s,]/g, '');
    assertValid(
      consumed && remainder === '',
      `${owner} importScripts() must use only literal local paths.`
    );
  }

  const runtimeUrlPattern = /\b(?:chrome|browser)\.runtime\.getURL\s*\(([^)]*)\)/g;
  while ((match = runtimeUrlPattern.exec(source))) {
    const literal = /^\s*(["'])(.*?)\1\s*$/.exec(match[1]);
    assertValid(
      Boolean(literal),
      `${owner} runtime.getURL() must use one literal local path.`
    );
    addReference(references, literal[2], `${owner} runtime.getURL()`, {
      allowLeadingSlash: true,
      allowRoot: true
    });
  }

  const dynamicImportPattern = /\bimport\s*\(([^)]*)\)/g;
  while ((match = dynamicImportPattern.exec(source))) {
    const literal = /^\s*(["'])(.*?)\1\s*$/.exec(match[1]);
    assertValid(
      Boolean(literal),
      `${owner} import() must use one literal local path.`
    );
    addReference(references, literal[2], `${owner} import()`);
  }

  const staticImportPattern = /\b(?:import|export)\s+(?:[^'"]+\s+from\s+)?(["'])(.*?)\1/g;
  while ((match = staticImportPattern.exec(source))) {
    addReference(references, match[2], `${owner} module import`);
  }

  const workerPattern = /\bnew\s+(?:Shared)?Worker\s*\(([^)]*)\)/g;
  while ((match = workerPattern.exec(source))) {
    const firstArgument = match[1].split(',', 1)[0];
    const literal = /^\s*(["'])(.*?)\1\s*$/.exec(firstArgument);
    assertValid(
      Boolean(literal),
      `${owner} Worker() must use a literal local path as its first argument.`
    );
    addReference(references, literal[2], `${owner} Worker()`);
  }

  return references;
}

function collectFileReferences(relativePath, source, manifest) {
  if (relativePath === 'manifest.json') {
    return collectManifestReferences(manifest);
  }
  if (/\.html?$/i.test(relativePath)) {
    return collectHtmlReferences(source, relativePath);
  }
  if (/\.css$/i.test(relativePath)) {
    return collectCssReferences(source, relativePath);
  }
  if (/\.js$/i.test(relativePath)) {
    return collectJavaScriptReferences(source, relativePath);
  }
  return new Set();
}

function validateFile(rootPath, relativePath) {
  assertValid(!isDangerousPath(relativePath), `Release allowlist contains a forbidden path: ${relativePath}`);
  const absolutePath = path.join(rootPath, relativePath);
  assertValid(fs.existsSync(absolutePath), `Required release file is missing: ${relativePath}`);
  const stats = fs.lstatSync(absolutePath);
  assertValid(!stats.isSymbolicLink(), `Release files must not be symlinks: ${relativePath}`);
  assertValid(stats.isFile(), `Release path must be a regular file: ${relativePath}`);
}

function validateRootRuntimeFiles(rootPath, releaseSet) {
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    if (!entry.isFile() || !RUNTIME_FILE_PATTERN.test(entry.name)) continue;
    if (entry.name === 'package.json') continue;
    assertValid(
      releaseSet.has(entry.name),
      `Unexpected root-level runtime-looking file is not allowlisted: ${entry.name}`
    );
  }
}

function validateExtension(rootPath = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(rootPath);
  const releaseSet = new Set(RELEASE_FILES);
  assertValid(
    releaseSet.size === RELEASE_FILES.length,
    'Release allowlist contains duplicate paths.'
  );

  RELEASE_FILES.forEach((relativePath) => validateFile(resolvedRoot, relativePath));
  validateRootRuntimeFiles(resolvedRoot, releaseSet);

  const manifestPath = path.join(resolvedRoot, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new ValidationError(`manifest.json is not valid JSON: ${error.message}`);
  }

  const packagePath = path.join(resolvedRoot, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new ValidationError(`package.json is not valid JSON: ${error.message}`);
  }
  assertValid(packageJson.private === true, 'package.json must remain private.');
  for (const dependencyField of [
    'dependencies',
    'optionalDependencies',
    'peerDependencies',
    'bundledDependencies',
    'bundleDependencies'
  ]) {
    const dependencies = packageJson[dependencyField];
    assertValid(
      dependencies === undefined ||
        (typeof dependencies === 'object' &&
          dependencies !== null &&
          Object.keys(dependencies).length === 0),
      `package.json must not declare runtime dependencies (${dependencyField}).`
    );
  }
  assertValid(
    packageJson.version === manifest.version,
    `package.json version ${packageJson.version} does not match manifest version ${manifest.version}.`
  );

  const discovered = new Set(['manifest.json']);
  const pending = ['manifest.json'];

  while (pending.length) {
    const relativePath = pending.shift();
    const absolutePath = path.join(resolvedRoot, relativePath);
    const source = /\.(?:css|html?|js|json)$/i.test(relativePath)
      ? fs.readFileSync(absolutePath, 'utf8')
      : null;
    const references = collectFileReferences(relativePath, source, manifest);

    for (const reference of references) {
      assertValid(
        releaseSet.has(reference),
        `${relativePath} references a runtime file outside the release allowlist: ${reference}`
      );
      validateFile(resolvedRoot, reference);
      if (!discovered.has(reference)) {
        discovered.add(reference);
        pending.push(reference);
      }
    }
  }

  const unreachable = RELEASE_FILES.filter((relativePath) => !discovered.has(relativePath));
  assertValid(
    unreachable.length === 0,
    `Allowlisted runtime files are not reachable from manifest/runtime references: ${unreachable.join(', ')}`
  );

  return {
    manifest,
    root: resolvedRoot,
    releaseFiles: [...RELEASE_FILES],
    checks: {
      manifestVersion: 3,
      remoteCodeRejected: true,
      dangerousFilesRejected: true,
      runtimeReferenceClosureComplete: true,
      symlinksRejected: true,
      zeroRuntimeDependencies: true
    }
  };
}

function parseCliArguments(argv) {
  let root = DEFAULT_ROOT;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = path.resolve(argv[index + 1] || '');
      index += 1;
    } else if (argument === '--json') {
      json = true;
    } else {
      throw new ValidationError(`Unknown argument: ${argument}`);
    }
  }

  return { root, json };
}

if (require.main === module) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const result = validateExtension(options.root);
    const summary = {
      ok: true,
      manifestVersion: result.manifest.manifest_version,
      extensionVersion: result.manifest.version,
      releaseFileCount: result.releaseFiles.length,
      checks: result.checks
    };
    process.stdout.write(
      options.json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : `Extension validation passed (${summary.releaseFileCount} allowlisted files, MV${summary.manifestVersion}, version ${summary.extensionVersion}).\n`
    );
  } catch (error) {
    process.stderr.write(`Extension validation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  RELEASE_FILES,
  ValidationError,
  validateExtension
};
