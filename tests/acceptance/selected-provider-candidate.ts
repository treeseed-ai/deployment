import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

/** Link the existing frozen source/runtime observations to independent Git
 * candidates. This adds no runtime selection, receipt or configuration field. */
export function verifySelectedProviderCandidate(selectedHead: string, heldHead: string, frozen: unknown, runtime: unknown, currentHost: unknown): void {
  const fail = 'SOURCE_BUILD_HELD_CANDIDATE: Selected provider differs from the held Agent source or frozen runtime';
  for (const head of [selectedHead, heldHead]) assert.match(head, /^[a-f0-9]{40}$/u, fail);
  assert.ok(frozen && typeof frozen === 'object' && !Array.isArray(frozen), fail);
  const freeze = frozen as Record<string, unknown>, sources = freeze.sourceHeads;
  assert.ok(sources && typeof sources === 'object' && !Array.isArray(sources), fail);
  assert.equal((sources as Record<string, unknown>).agent, heldHead, fail);
  assert.equal(selectedHead, heldHead, fail);
  assert.ok(runtime && typeof runtime === 'object' && !Array.isArray(runtime), fail);
  assert.deepEqual(freeze.runtimeTargets, runtime, fail);
  const record=(value:unknown):Record<string,unknown>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),fail);return value as Record<string,unknown>;};
  const host=record(freeze.host),guest=record(freeze.guest),observed=record(currentHost),digest=/^sha256:[a-f0-9]{64}$/u;
  assert.equal(host.status,'active',fail);assert.equal(observed.status,'active',fail);assert.ok(typeof host.generationId==='string'&&host.generationId.length>0,fail);
  for(const field of ['generationId','manifestDigest','guestImageDigest'])assert.equal(observed[field],host[field],fail);
  assert.ok(typeof host.manifestDigest==='string'&&digest.test(host.manifestDigest)&&typeof guest.digest==='string'&&digest.test(guest.digest),fail);assert.equal(host.guestImageDigest,guest.digest,fail);
  for(const value of [host,observed]){
    assert.ok(Array.isArray(value.files)&&value.files.length>0&&value.files.length<=4096,fail);const paths=new Set<string>();
    for(const raw of value.files){const file=record(raw);assert.deepEqual(Object.keys(file).sort(),['path','sha256','size'],fail);assert.ok(typeof file.path==='string'&&file.path.length>0&&!paths.has(file.path)&&Number.isSafeInteger(file.size)&&Number(file.size)>=0&&typeof file.sha256==='string'&&digest.test(file.sha256),fail);paths.add(file.path);}
    assert.equal(value.manifestDigest,'sha256:'+createHash('sha256').update(JSON.stringify(value.files)).digest('hex'),fail);
  }
  assert.deepEqual(observed.files,host.files,fail);
}
