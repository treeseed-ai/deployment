import { loadHostConfiguration } from '../core/configuration.js';
import { recordEvent } from '../core/events.js';
import { renderCaddyfile, subjectAlternativeNames } from '../edge/caddy.js';
import { requestSupervisor } from '../supervisor/client.js';
import { loadActiveComponents } from './current-state.js';
import { reconcile, rollbackRoutes } from './reconcile.js';
import { assertTreeDxResetSafe } from './reset-safety.js';

const composeFiles = (component: ReturnType<typeof loadActiveComponents>[number]) => component.runtime.compose.files.map((file) => `${component.componentId}/${component.release}/${file.path}`);

export async function resetAndReconcile() {
	const host = loadHostConfiguration(), active = loadActiveComponents();
	const componentDataRoot = host.runtime.environment === 'development' ? host.runtime.dataRoot! : '/var/lib/treeseed/components';
	await assertTreeDxResetSafe(componentDataRoot);
	for (const component of [...active].reverse()) await requestSupervisor({ operation: 'compose.remove', componentId: component.componentId, projectName: component.runtime.compose.projectName, files: composeFiles(component) });
	await requestSupervisor({ operation: 'platform.reset', componentDataRoot });
	const managerRoutes = rollbackRoutes(host, []);
	await requestSupervisor({ operation: 'edge.apply', caddyfile: renderCaddyfile(managerRoutes), aliases: subjectAlternativeNames(managerRoutes) });
	recordEvent('platform.reset-complete', { components: active.map((component) => component.componentId).sort() });
	return reconcile();
}
