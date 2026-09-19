const digestPattern = /^sha256:[a-f0-9]{64}$/u;

/**
 * A catalog generation is an integration identity, but its serialized contract
 * can also change as the SDK evolves. Include both in the Debian identity so
 * APT never treats different catalog bytes as an already-installed package.
 */
export function catalogDebianVersion(catalog: { release: string; generation: number; catalogDigest: string }) {
	if (!/^\d+\.\d+\.\d+(?:~rc\d+)?$/u.test(catalog.release)) throw new Error('Catalog release is not a Debian-compatible version.');
	if (!Number.isInteger(catalog.generation) || catalog.generation < 1) throw new Error('Catalog generation is not a positive integer.');
	if (!digestPattern.test(catalog.catalogDigest)) throw new Error('Catalog digest is invalid.');
	return `${catalog.release}-${catalog.generation}+catalog.${catalog.catalogDigest.slice(7, 19)}`;
}
