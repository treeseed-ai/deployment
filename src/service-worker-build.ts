import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fstatSync, lstatSync, chmodSync, linkSync, unlinkSync, rmdirSync, fsyncSync, openSync, closeSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SafeDirectory, PlanningFailure as Check } from './filesystem.js';
import { InstallationStore } from './installed.js';
/** Trusted release build-time producer. Never used by plan/apply or source package scripts. */
export class ServiceWorkerBuild {
    static produce(path: string): { path: string; sha256: string; size: number } {
        Check.require(path.startsWith('/') && resolve(path) === path && process.platform === 'linux' && process.arch === 'x64', 'WORKER_BUILD_TARGET');
        const directory = SafeDirectory.open(path);
        let building: SafeDirectory | undefined;
        try {
            SafeDirectory.owner(fstatSync(directory.fd), true);
            Check.require(directory.entries().length === 0, 'WORKER_BUILD_CONFLICT');
            const environment = { PATH: process.env.PATH, HOME: process.env.HOME }, version = spawnSync('bun', ['--version'], { env: environment, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 });
            Check.require(version.status === 0 && version.stdout.trim() === '1.4.4', 'WORKER_BUILD_COMPILER');
            const temporary = 'building-' + randomUUID();
            building = InstallationStore.mkdir(directory, temporary);
            const result = spawnSync('bun', ['build', fileURLToPath(new URL('./service-worker.js', import.meta.url)), '--compile', '--target=bun-linux-x64', '--outfile', join(building.path, 'worker')], { env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
            Check.require(result.status === 0 && building.entries().join(',') === 'worker', 'WORKER_BUILD_FAILED');
            const bytes = building.file('worker', undefined, 512 * 1024 * 1024);
            Check.require(bytes.length > 0, 'WORKER_BUILD_FAILED');
            const descriptor = { path: 'worker', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
            chmodSync(building.childPath('worker'), 0o500);
            const fd = openSync(building.childPath('worker'), constants.O_RDONLY | constants.O_NOFOLLOW);
            try { fsyncSync(fd); } finally { closeSync(fd); }
            directory.verify(); building.verify();
            Check.require(directory.entries().join(',') === temporary, 'WORKER_BUILD_CONFLICT');
            linkSync(building.childPath('worker'), directory.childPath('worker'));
            unlinkSync(building.childPath('worker'));
            fsyncSync(building.fd); building.close(); building = undefined;
            rmdirSync(directory.childPath(temporary)); fsyncSync(directory.fd);
            const stat = lstatSync(directory.childPath('worker'));
            Check.require(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o500, 'WORKER_BUILD_INTEGRITY');
            directory.hash('worker', descriptor.sha256, descriptor.size); directory.verify();
            return descriptor;
        } finally { building?.close(); directory.close(); }
    }
}
