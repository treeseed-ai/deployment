import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { componentReleaseSchema, type ComponentRelease } from '@treeseed/sdk/deployment';
import { paths } from '../../core/paths.js';
import { nodeStorageProbe, pythonStorageProbe } from './storage-probes.js';

type Capture = (args: string[]) => string;
const capture: Capture = args => execFileSync('/usr/bin/docker', args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 8192,
	stdio: ['ignore','pipe','pipe'], env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
const probes = [
	{ component: 'ai-inference', service: 'inference-api', interpreter: 'node', program: nodeStorageProbe },
	{ component: 'ai-training', service: 'training-api', interpreter: 'node', program: nodeStorageProbe },
	{ component: 'ai-training', service: 'artifact', interpreter: 'python', program: pythonStorageProbe },
];

/** Fixed targets, exact accepted images, bounded execution, public results only. */
export function verifyAiStorage(options: { capture?: Capture; components?: ComponentRelease[] } = {}) {
	const run = options.capture ?? capture;
	const components = options.components ?? JSON.parse(readFileSync(`${paths.managerState}/active-components.json`, 'utf8')).map((value: unknown) => componentReleaseSchema.parse(value));
	const results = probes.map(probe => {
		try {
			const component = components.find((item: ComponentRelease) => item.componentId === probe.component);
			if (!component || !component.runtime.services.some((item: {composeService:string}) => item.composeService === probe.service)) throw Error();
			const ids = run(['ps','--quiet','--filter',`label=com.docker.compose.project=${component.runtime.compose.projectName}`,
				'--filter',`label=com.docker.compose.service=${probe.service}`]).trim().split(/\s+/u);
			if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/u.test(ids[0]!)) throw Error();
			const image = run(['inspect','--format','{{.Config.Image}}',ids[0]!]).trim();
			if (!component.images.some((item: {repository:string;digest:string}) => `${item.repository}@${item.digest}` === image)) throw Error();
			const args = probe.interpreter === 'node' ? ['node','--input-type=module','-e',probe.program] : ['python','-c',probe.program];
			const result = JSON.parse(run(['exec','--workdir','/app',ids[0]!,...args]));
			if (typeof result.ok !== 'boolean' || typeof result.cleanup !== 'boolean' || !['write','read','list','object-isolation','team-isolation','action-isolation','workload-isolation','complete'].includes(result.phase)
				|| !/^\.treeseed-acceptance\/[a-f0-9-]{36}\/probe$/u.test(result.key)) throw Error();
			return { service: probe.service, ok: result.ok && result.cleanup && result.phase === 'complete', cleanup: result.cleanup, phase: result.phase, object: result.key };
		} catch { return { service: probe.service, ok: false, cleanup: false, phase: 'runtime-probe-unavailable' }; }
	});
	return { schemaVersion: 'treeseed.ai-storage-verification/v1', ok: results.every(result => result.ok), results, trainingExecuted: false, artifactsMoved: false };
}
