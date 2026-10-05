export function containerdImageReference(image: string, digest: string) {
	if (image.includes('@')) throw new Error('Sandbox image names must not contain a digest.');
	const segments = image.split('/');
	const first = segments[0]!;
	const qualified = first === 'localhost' || first.includes('.') || first.includes(':')
		? image
		: segments.length === 1 ? `docker.io/library/${image}` : `docker.io/${image}`;
	return `${qualified}@${digest}`;
}
