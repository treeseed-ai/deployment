import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { CanonicalJson } from '@treeseed-cordis/sdk';
import * as Sandbox from '@treeseed-cordis/deployment/sandbox';

interface NetworkProjection {
  read(spec: unknown, bootDigest: unknown, interfaceText: unknown): object;
}
class NativeNetworkCases {
  static readonly spec = { linux: { namespaces: [{ type: 'network' }] } };
  static readonly boot = 'a'.repeat(64);
  static readonly interfaces = '/sys/class/net/lo\n';
  private projection(): NetworkProjection {
    const Type = Reflect.get(Sandbox, 'NativeNetworkProjection');
    assert.equal(typeof Type, 'function', 'Public native network projection missing');
    return new Type() as NetworkProjection;
  }
  accepted(path: string | undefined): void {
    const spec = { linux: { namespaces: [{ type: 'pid' }, { type: 'network', path }] } };
    const result = this.projection().read(
      spec,
      NativeNetworkCases.boot,
      NativeNetworkCases.interfaces,
    );
    const content = {
      kind: 'kata-offline-network',
      formatVersion: 1,
      mode: 'offline',
      namespace: 'private',
      bootDigest: NativeNetworkCases.boot,
    };
    assert.deepEqual(result, { ...content, digest: CanonicalJson.digest(content) });
    assert(Object.isFrozen(result));
  }
  rejected(spec: unknown, boot: unknown, interfaces: unknown): void {
    const projection = this.projection();
    assert.throws(projection.read.bind(projection, spec, boot, interfaces), this.safe.bind(this));
  }
  private safe(error: unknown): boolean {
    assert(error instanceof Error);
    assert.equal(error.message, 'KATA_NATIVE_NETWORK_INVALID');
    assert.equal(Reflect.get(error, 'cause'), undefined);
    assert(!String(error).includes('PRIVATE_'));
    return true;
  }
}
const suite = new NativeNetworkCases();
test(
  'unit: native network accepts exact private loopback undefined',
  suite.accepted.bind(suite, undefined),
);
for (const spec of [
  null,
  {},
  { linux: {} },
  { linux: { namespaces: [] } },
  { linux: { namespaces: [{ type: 'pid' }] } },
  { linux: { namespaces: [{ type: 'network', path: '' }] } },
  { linux: { namespaces: [{ type: 'network', path: '/proc/1/ns/net' }] } },
  { linux: { namespaces: [{ type: 'network', path: '/PRIVATE_NAMESPACE' }] } },
  { linux: { namespaces: [{ type: 'network', path: ' ' }] } },
  { linux: { namespaces: [{ type: 'network' }, { type: 'network' }] } },
  { linux: { namespaces: [{ type: 'network' }, { type: 1 }] } },
  { linux: { namespaces: [{ type: 'network', path: null }] } },
  { linux: { namespaces: new Array(65).fill({ type: 'network' }) } },
])
  test(
    'unit: native network rejects malformed or external namespace ' + JSON.stringify(spec),
    suite.rejected.bind(suite, spec, NativeNetworkCases.boot, NativeNetworkCases.interfaces),
  );
for (const interfaces of [
  '',
  'lo\n',
  '/sys/class/net/lo',
  '/sys/class/net/lo\n\n',
  '/sys/class/net/eth0\n/sys/class/net/lo\n',
  '/sys/class/net/lo\n/sys/class/net/lo\n',
  '/sys/class/net/lo\r\n',
  '/sys/class/net/*\n',
  '/PRIVATE_INTERFACES\n',
  null,
])
  test(
    'unit: native network rejects noncanonical guest interfaces ' + JSON.stringify(interfaces),
    suite.rejected.bind(suite, NativeNetworkCases.spec, NativeNetworkCases.boot, interfaces),
  );
for (const boot of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), null])
  test(
    'unit: native network rejects invalid boot digest ' + JSON.stringify(boot),
    suite.rejected.bind(suite, NativeNetworkCases.spec, boot, NativeNetworkCases.interfaces),
  );
