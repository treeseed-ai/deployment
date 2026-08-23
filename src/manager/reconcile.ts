import { existsSync, readFileSync } from 'node:fs';
import { hostReceiptSchema, type HostReceipt } from '@treeseed/sdk/deployment';
import { loadCatalog } from '../catalog/load.js';
import { loadHostConfiguration } from '../core/configuration.js';
import { atomicJson } from '../core/files.js';
import { recordEvent } from '../core/events.js';
import { paths } from '../core/paths.js';
import { renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { createPlan } from './plan.js';
import { activationEligible } from './update-policy.js';
import { validateProductionCompose } from '../runtime/compose.js';
import { requestSupervisor } from '../supervisor/client.js';

function previousReceipt(): HostReceipt | undefined {
	const path = `${paths.managerState}/current-receipt.json`;
	return existsSync(path) ? hostReceiptSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined;
}

export async function reconcile(track?: 'stable' | 'development') {
	const host = loadHostConfiguration();
	const stable = loadCatalog(`${paths.catalogs}/stable.json`);
	const developmentPath = `${paths.catalogs}/development.json`;
	const previous = previousReceipt();
	const accepted = createPlan(host, stable, existsSync(developmentPath) ? loadCatalog(developmentPath) : undefined, previous);
	if (accepted.plan.blockers.length) throw new Error(`Host plan is blocked: ${accepted.plan.blockers.map((item) => item.code).join(', ')}`);
	for (const component of accepted.components) validateProductionCompose(component, `${paths.bundles}/${component.componentId}/${component.release}`);
	if (track === 'stable' && previous && !activationEligible(host, 'stable')) {
		recordEvent('update.metadata-current', { track, eligible: false, catalogDigest: stable.catalogDigest });
		return previous;
	}
	const targets = previous && track ? accepted.components.filter((component) => host.components[component.componentId]?.track === track) : accepted.components;
	const changedIds = new Set(accepted.plan.changes.filter((change) => change.action !== 'noop').map((change) => change.componentId));
	const changed = targets.filter((component) => changedIds.has(component.componentId));
	if (changed.length === 0 && previous) {
		recordEvent('reconcile.noop', { track: track ?? 'all', receiptId: previous.receiptId });
		return previous;
	}
	const packages = changed.flatMap((component) => component.packages).sort((left, right) => left.order - right.order).map((item) => `${item.name}=${item.version}`);
	if (packages.length) await requestSupervisor({ operation: 'apt.install', packages });
	for (const component of changed) await requestSupervisor({ operation: 'compose.activate', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: component.runtime.compose.files.map((file) => `${component.componentId}/${component.release}/${file}`) });
	await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(accepted.routes), aliases: subjectAlternativeNames(accepted.routes) });
	const receipt = hostReceiptSchema.parse({ schemaVersion: 'treeseed.host-receipt/v1', receiptId: `receipt-${Date.now()}`, planId: accepted.plan.planId, state: 'known-good', configurationDigest: accepted.plan.configurationDigest, catalogDigest: accepted.plan.catalogDigest, packages: accepted.components.flatMap((component) => component.packages), images: accepted.components.flatMap((component) => component.images), completedAt: new Date().toISOString() });
	atomicJson(`${paths.receipts}/${receipt.receiptId}.json`, receipt);
	atomicJson(`${paths.managerState}/current-receipt.json`, receipt);
	recordEvent('reconcile.complete', { receiptId: receipt.receiptId, planId: receipt.planId });
	return receipt;
}
