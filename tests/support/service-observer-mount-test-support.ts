import { test, expect } from 'bun:test';
import { createServer, type Server } from 'node:net';
import { mkdirSync, chmodSync, linkSync, unlinkSync, renameSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ObserverServiceFixture } from './service-observer-fixture.js';
import { ServiceReleaseFixture } from './release-fixture.js';
import { ComposeDeploymentHost } from '@treeseed-cordis/deployment';
import { ServiceObserverMount } from '../../src/service-observer-mount.js';
export class ObserverMountTests {
    protected server: Server | null = null; protected socket = '';
    protected listen(accept: (value: void) => void): void { this.server!.listen(this.socket, accept); }
    protected close(accept: (value: void) => void): void { this.server!.close(this.closed.bind(this, accept)); }
    protected closed(accept: (value: void) => void): void { accept(); }
}
