import type { ComponentRelease } from '@treeseed/sdk/deployment';

export function applyRuntimeBuildIdentity(
	component: ComponentRelease,
	environment: Record<string, string>,
	required: boolean,
) {
	if (component.componentId !== 'agent') return;
	const digest = component.images.find((image) => image.role === 'agent-runner')?.digest;
	if (digest && /^sha256:[a-f0-9]{64}$/u.test(digest)) environment.TREESEED_PROVIDER_RUNTIME_BUILD = digest;
	else if (required) throw new Error('Agent release requires an exact runner image digest for assignment build identity.');
}
