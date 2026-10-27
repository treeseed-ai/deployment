import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { ArtifactResolver, type PackageData } from '../../src/artifacts.js';
class LockProbe extends ArtifactResolver { check(root: Record<string, unknown>, lock: Record<string, unknown>, packages: Map<string, PackageData>): void { this.lock(root, lock, packages, true); } }
/** Synthetic lock-stage inputs; the outer API program supplies genuine ajv-formats archives. */
class LockedPeerTests {
    private sample(): { root: Record<string, unknown>; lock: Record<string, unknown>; packages: Map<string, PackageData>; records: Record<string, unknown[]> } {
        const packages = new Map<string, PackageData>(), records: Record<string, unknown[]> = {}, dependencies = { '@fixture/consumer': '1.0.0', '@fixture/provider': '8.17.1' };
        for (const [name, version] of Object.entries(dependencies)) { const bytes = Buffer.from(name + '-lock-stage-fixture'), metadata: Record<string, unknown> = { name, version }; if (name === '@fixture/consumer') { metadata.dependencies = { '@fixture/provider': '^8.0.0' }; metadata.peerDependencies = { '@fixture/provider': '^8.0.0' }; metadata.peerDependenciesMeta = { '@fixture/provider': { optional: true } }; } const sha256 = createHash('sha256').update(bytes).digest('hex'); packages.set(name, { bytes, metadata, entry: { name, version, path: name.slice('@fixture/'.length) + '.tgz', sha256 }, files: new Set(), hashes: new Map(), sizes: new Map() }); records[name] = [name + '@' + version, '', name === '@fixture/consumer' ? { dependencies: metadata.dependencies } : {}, 'sha512-' + createHash('sha512').update(bytes).digest('base64')]; }
        return { root: { dependencies }, lock: { lockfileVersion: 2, configVersion: 1, workspaces: { '': { dependencies } }, packages: records }, packages, records };
    }
    normalized(): void { const fixture = this.sample(); new LockProbe().check(fixture.root, fixture.lock, fixture.packages); expect(fixture.packages.size).toBe(2); }
    denied(): void {
        for (const change of ['range', 'missing', 'integrity', 'unknown-peer']) {
            const fixture = this.sample(), consumer = fixture.packages.get('@fixture/consumer')!, metadata = fixture.records['@fixture/consumer']![2] as Record<string, unknown>;
            if (change === 'range') consumer.metadata.peerDependencies = { '@fixture/provider': '^7.0.0' };
            if (change === 'missing') { fixture.packages.delete('@fixture/provider'); delete fixture.records['@fixture/provider']; delete (fixture.root.dependencies as Record<string, string>)['@fixture/provider']; }
            if (change === 'integrity') fixture.records['@fixture/consumer']![3] = 'sha512-' + Buffer.alloc(64).toString('base64');
            if (change === 'unknown-peer') metadata.peerDependencies = { '@fixture/foreign': '^1.0.0' };
            expect(new LockProbe().check.bind(new LockProbe(), fixture.root, fixture.lock, fixture.packages)).toThrow();
        }
    }
    optional(): void { const fixture = this.sample(), metadata = fixture.packages.get('@fixture/consumer')!.metadata, record = fixture.records['@fixture/consumer']![2] as Record<string, unknown>; metadata.peerDependencies = { '@fixture/optional': '^1.0.0' }; metadata.peerDependenciesMeta = { '@fixture/optional': { optional: true } }; record.peerDependencies = metadata.peerDependencies; record.optionalPeers = ['@fixture/optional']; new LockProbe().check(fixture.root, fixture.lock, fixture.packages); expect(fixture.packages.has('@fixture/optional')).toBe(false); }
}
const lockedPeers = new LockedPeerTests();
test('unit: identical regular optional peer constraints match genuine Bun lock normalization', lockedPeers.normalized.bind(lockedPeers));
test('unit: normalized peers retain mandatory dependencies exact ranges declared peers and integrity', lockedPeers.denied.bind(lockedPeers));
test('unit: an independently optional absent peer still requires its explicit lock declaration', lockedPeers.optional.bind(lockedPeers));
