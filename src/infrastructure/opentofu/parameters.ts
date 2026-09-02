import type { HostedTopologyPlan } from '@treeseed/sdk/deployment';

type Action = HostedTopologyPlan['actions'][number];
type Parameter = Action['desiredResource']['parameters'][string];

export interface ParameterContext {
	config: Record<string, string | number | boolean>;
	artifacts: HostedTopologyPlan['artifacts'];
	outputs?: Record<string, Record<string, string>>;
}

export function resolveHostedInfrastructureParameter(parameter: Parameter | undefined, context: ParameterContext) {
	if (!parameter) return undefined;
	if ('literal' in parameter) return parameter.literal;
	if ('input' in parameter) {
		const value = context.config[parameter.input];
		if (value === undefined) throw new Error(`Hosted infrastructure input ${parameter.input} is unavailable.`);
		return value;
	}
	if ('artifact' in parameter) {
		const artifact = context.artifacts[parameter.artifact];
		if (!artifact) throw new Error(`Hosted infrastructure artifact ${parameter.artifact} is unavailable.`);
		return { ...artifact, id: parameter.artifact };
	}
	const value = context.outputs?.[parameter.resourceOutput.resourceId]?.[parameter.resourceOutput.output];
	if (!value) throw new Error(`Hosted infrastructure output ${parameter.resourceOutput.resourceId}.${parameter.resourceOutput.output} is unavailable.`);
	return value;
}

export function requiredInfrastructureString(value: unknown, label: string) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Hosted infrastructure parameter ${label} is required.`);
	return value.trim();
}
