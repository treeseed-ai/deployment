import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { identityComponentBundle } from '../src/identity/release.js';

const version = String(JSON.parse(readFileSync('package.json', 'utf8')).version);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const bundle = identityComponentBundle(version, commit);
mkdirSync('release/out', { recursive: true });
writeFileSync('release/out/identity-component-release.json', `${JSON.stringify(bundle.component, null, 2)}\n`);
writeFileSync('release/out/identity-compose.yml', bundle.compose);
console.log(JSON.stringify({ componentId: bundle.component.componentId, release: bundle.component.release, runtimeDigest: bundle.component.runtimeDigest }));
