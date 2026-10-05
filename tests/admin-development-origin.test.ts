import { expect, it } from 'vitest';
import { host, component } from './fixtures.js';
import { managedDevelopmentConnectionEnvironment } from '../src/manager/reconcile.js';

it('preserves the canonical HTTPS alias across development recovery and overrides', () => {
	const configuration = host(), admin = component('admin', 'development', 'b');
 configuration.components.admin = { enabled: true, track: 'development', aliases: {}, connections: {}, configuration: {}, resources: { gpuDevices: [] } };
	expect(managedDevelopmentConnectionEnvironment(configuration, admin, [admin]).TREESEED_SITE_URL).toBe('https://admin.treeseed.localhost');
	configuration.components.admin.aliases['admin.service.http'] = 'console.treeseed.localhost';
	expect(managedDevelopmentConnectionEnvironment(configuration, admin, [admin]).TREESEED_SITE_URL).toBe('https://console.treeseed.localhost');
	admin.runtime.services.push({ ...structuredClone(admin.runtime.services[0]!), id: 'second', endpoints: [{ ...admin.runtime.services[0]!.endpoints[0]!, defaultAlias: 'second.treeseed.localhost' }] });
	expect(() => managedDevelopmentConnectionEnvironment(configuration, admin, [admin])).toThrow('unambiguous');
});
