import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

/** Verify the representation consumed by the manager, including schema defaults.
 * Never repair a declared digest while reading an immutable release. */
export function verifiedComponentRelease(input: unknown) {
  const release = componentReleaseSchema.parse(input);
  if (deploymentDigest(release.runtime) !== release.runtimeDigest) {
    throw new Error(`Component ${release.componentId}@${release.release} runtime digest mismatch`);
  }
  return release;
}
