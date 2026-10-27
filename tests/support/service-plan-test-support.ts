import { DockerCommands } from '../../src/diagnose.js';
import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, statSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ServiceReleaseFixture } from './release-fixture.js';
export class ReadonlyCommands extends DockerCommands {
    calls = 0;
    override execute(args: string[]): string | null { const operation = args[0] === '--context' ? args.slice(2) : args, kind = operation[0], subcommand = operation[1]; if (!(kind === 'context' && subcommand === 'inspect' || kind === 'info' || kind === 'compose' && subcommand === 'version' || kind === 'ps' || ['network', 'volume'].includes(kind ?? '') && subcommand === 'ls'))
        throw new Error('Modifying engine operation refused'); this.calls++; return super.execute(args); }
}
