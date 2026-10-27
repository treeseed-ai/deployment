import { test, expect } from 'bun:test';
import { Header } from 'tar';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceRuntimeFixture } from './service-runtime-fixture.js';
export class AuthorityExportTests {
    protected archive(path: string, data: Buffer, type: 'File' | 'SymbolicLink' = 'File'): Buffer { const header = Buffer.alloc(512); new Header({ path, type, size: type === 'File' ? data.length : 0, mode: 0o644, linkpath: type === 'SymbolicLink' ? 'private-key.pem' : undefined }).encode(header); return Buffer.concat([header, type === 'File' ? data : Buffer.alloc(0), Buffer.alloc(type === 'File' ? (512 - data.length % 512) % 512 : 0), Buffer.alloc(1024)]); }
}
