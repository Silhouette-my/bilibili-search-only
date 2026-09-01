'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  RELEASE_FILES,
  ValidationError,
  validateExtension
} = require('./validate-extension.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 0x0021;
const UTF8_FLAG = 0x0800;
const STORED_METHOD = 0;

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function createLocalHeader(nameBuffer, data, checksum) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(STORED_METHOD, 8);
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function createCentralHeader(nameBuffer, data, checksum, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(STORED_METHOD, 10);
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function createEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

function createDeterministicZip(entries) {
  assert.ok(entries.length <= 0xffff, 'ZIP64 is not supported by this release packager.');

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, 'utf8');
    const checksum = crc32(entry.data);
    const localHeader = createLocalHeader(nameBuffer, entry.data, checksum);

    localParts.push(localHeader, nameBuffer, entry.data);
    centralParts.push(
      createCentralHeader(nameBuffer, entry.data, checksum, offset),
      nameBuffer
    );
    offset += localHeader.length + nameBuffer.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    createEndOfCentralDirectory(entries.length, centralDirectory.length, offset)
  ]);
}

function parseCliArguments(argv) {
  let root = DEFAULT_ROOT;
  let outputDirectory = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = path.resolve(argv[index + 1] || '');
      index += 1;
    } else if (argument === '--out-dir') {
      outputDirectory = path.resolve(argv[index + 1] || '');
      index += 1;
    } else {
      throw new ValidationError(`Unknown argument: ${argument}`);
    }
  }

  return {
    root,
    outputDirectory: outputDirectory || path.join(root, 'dist')
  };
}

function packageExtension(options) {
  const validation = validateExtension(options.root);
  const entries = [...RELEASE_FILES]
    .sort(comparePaths)
    .map((relativePath) => ({
      path: relativePath,
      data: fs.readFileSync(path.join(validation.root, relativePath))
    }));

  const archive = createDeterministicZip(entries);
  const rebuiltArchive = createDeterministicZip(entries);
  assert.deepEqual(
    archive,
    rebuiltArchive,
    'The release archive was not reproducible within the same process.'
  );

  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  const safeVersion = validation.manifest.version.replace(/[^0-9.]/g, '');
  const archiveName = `bilibili-focus-${safeVersion}.zip`;
  const digestName = `${archiveName}.sha256`;

  fs.mkdirSync(options.outputDirectory, { recursive: true });
  const archivePath = path.join(options.outputDirectory, archiveName);
  const digestPath = path.join(options.outputDirectory, digestName);
  fs.writeFileSync(archivePath, archive, { mode: 0o644 });
  fs.writeFileSync(digestPath, `${digest}  ${archiveName}\n`, {
    encoding: 'utf8',
    mode: 0o644
  });

  return {
    archivePath,
    digestPath,
    sha256: digest,
    bytes: archive.length,
    files: entries.map((entry) => entry.path)
  };
}

if (require.main === module) {
  try {
    const options = parseCliArguments(process.argv.slice(2));
    const result = packageExtension(options);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      archive: result.archivePath,
      sha256File: result.digestPath,
      sha256: result.sha256,
      bytes: result.bytes,
      fileCount: result.files.length,
      deterministicTimestamp: '1980-01-01T00:00:00Z',
      compression: 'store'
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Extension packaging failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  createDeterministicZip,
  packageExtension
};
