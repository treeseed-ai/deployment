import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd(), output = resolve(root, 'release/out');
mkdirSync(output, { recursive: true });
const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', output], { cwd: root, encoding: 'utf8' })) as Array<{ filename: string }>;
const packed = result[0]?.filename;
if (!packed) throw new Error('npm pack did not produce the Deployment runtime artifact.');
const version = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version;
const target = resolve(output, `treeseed-deployment-runtime-${version}.tgz`);
rmSync(target, { force: true }); renameSync(resolve(output, packed), target);
console.log(JSON.stringify({ ok: true, artifact: target, version }));
