import assert from 'node:assert/strict';

/** Link the existing frozen source/runtime observations to independent Git
 * candidates. This adds no runtime selection, receipt or configuration field. */
export function verifySelectedProviderCandidate(selectedHead: string, heldHead: string, frozen: unknown, runtime: unknown): void {
  const fail = 'SOURCE_BUILD_HELD_CANDIDATE: Selected provider differs from the held Agent source or frozen runtime';
  for (const head of [selectedHead, heldHead]) assert.match(head, /^[a-f0-9]{40}$/u, fail);
  assert.ok(frozen && typeof frozen === 'object' && !Array.isArray(frozen), fail);
  const freeze = frozen as Record<string, unknown>, sources = freeze.sourceHeads;
  assert.ok(sources && typeof sources === 'object' && !Array.isArray(sources), fail);
  assert.equal((sources as Record<string, unknown>).agent, heldHead, fail);
  assert.equal(selectedHead, heldHead, fail);
  assert.ok(runtime && typeof runtime === 'object' && !Array.isArray(runtime), fail);
  assert.deepEqual(freeze.runtimeTargets, runtime, fail);
}
