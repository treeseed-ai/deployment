import { lstatSync, readFileSync } from 'node:fs';
import { componentReleaseSchema } from '@treeseed/sdk/deployment';

export function installedComponentRelease(componentId: string, release: string) {
	if (!/^[a-z][a-z0-9.-]+$/u.test(componentId) || !/^[0-9][a-zA-Z0-9.+~-]{0,127}$/u.test(release)) throw new Error('Invalid installed component release identity.');
	const parts = ['usr', 'share', 'treeseed', 'components', componentId, release, 'component-release.json'];
	let path = '';
	for (const [index, part] of parts.entries()) {
		path += `/${part}`;
		const stat = lstatSync(path);
		if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error('Installed component release must have root-owned, non-writable custody.');
		if (index === parts.length - 1 && stat.size > 4_194_304) throw new Error('Installed component release exceeds the size limit.');
	}
	const component = componentReleaseSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
	if (component.componentId !== componentId || component.release !== release) throw new Error('Installed component release identity mismatch.');
	return component;
}
