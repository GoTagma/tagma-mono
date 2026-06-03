import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractTarballStrip1 } from '../server/plugins/install';

const tempDirs: string[] = [];

function makeTempDir(name: string): string {
  const dir = resolve(
    join(tmpdir(), `tagma-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  );
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function writeString(buf: Buffer, offset: number, length: number, value: string): void {
  buf.write(value.slice(0, length), offset, length, 'utf-8');
}

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0');
  buf.write(`${text}\0`, offset, length, 'ascii');
}

function tarEntry(name: string, body: string, type = '0', linkName = ''): Buffer {
  const payload = Buffer.from(body, 'utf-8');
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, name);
  writeString(header, 100, 8, '0000644\0');
  writeString(header, 108, 8, '0000000\0');
  writeString(header, 116, 8, '0000000\0');
  writeOctal(header, 124, 12, payload.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, type);
  if (linkName) writeString(header, 157, 100, linkName);
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, '0');
  header.write(`${checksumText}\0 `, 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (payload.length % 512)) % 512, 0);
  return Buffer.concat([header, payload, padding]);
}

function writeRawTgz(path: string, entries: Buffer[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024, 0)])));
}

describe('plugin tarball extraction', () => {
  test('rejects mixed-separator traversal entries instead of accepting the archive', () => {
    const dir = makeTempDir('tar-traversal');
    const tgz = join(dir, 'plugin.tgz');
    const dest = join(dir, 'dest');
    writeRawTgz(tgz, [tarEntry('package/..\\evil.txt', 'outside')]);

    expect(() => extractTarballStrip1(tgz, dest)).toThrow(/unsafe relative path/i);
    expect(existsSync(resolve(dest, '..', 'evil.txt'))).toBe(false);
  });

  test('rejects link entries rather than silently dropping archive contents', () => {
    const dir = makeTempDir('tar-link');
    const tgz = join(dir, 'plugin.tgz');
    const dest = join(dir, 'dest');
    writeRawTgz(tgz, [tarEntry('package/link', '', '2', 'package/index.js')]);

    expect(() => extractTarballStrip1(tgz, dest)).toThrow(/unsupported link entry/i);
  });
});
