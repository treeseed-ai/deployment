export type ActivationDiagnostic = Record<string, unknown>;

function activationHealth(diagnostics: ActivationDiagnostic[], expectedServices: readonly string[]) {
	const byService = new Map(diagnostics.map((diagnostic) => [diagnostic.service, diagnostic]));
	const expected = expectedServices.map((service) => byService.get(service));
	if (expected.some((diagnostic) => !diagnostic)) return 'failed';
	if (expected.every((diagnostic) => diagnostic?.state === 'running' && (diagnostic.health === 'healthy' || diagnostic.health === 'none'))) return 'ready';
	if (expected.every((diagnostic) => diagnostic?.state === 'running' && (diagnostic.health === 'starting' || diagnostic.health === 'healthy' || diagnostic.health === 'none'))
		&& expected.some((diagnostic) => diagnostic?.health === 'starting')) return 'starting';
	return 'failed';
}

export function waitForStartingActivation(initialDiagnostics: ActivationDiagnostic[], expectedServices: readonly string[], inspect: () => ActivationDiagnostic[],
	deadline: number, sleep: (milliseconds: number) => void, now: () => number) {
	let diagnostics = initialDiagnostics;
	while (activationHealth(diagnostics, expectedServices) === 'starting' && now() < deadline) {
		sleep(Math.min(1_000, Math.max(1, deadline - now())));
		diagnostics = inspect();
	}
	return { ready: activationHealth(diagnostics, expectedServices) === 'ready', diagnostics };
}
