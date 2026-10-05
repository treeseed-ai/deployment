import { describe, expect, it, vi } from 'vitest';
import { routedActivation } from '../src/manager/routed-activation.js';

describe('dependency-facing route activation', () => {
  it.each(['release', 'rollback'])('switches %s routes before a consumer probes its dependency', async mode => {
    let route = 'stopped-live-api'; const order: string[] = [];
    await routedActivation({
      applyRoutes: async () => { route = mode; order.push('routes'); },
      activate: async () => { expect(route).toBe(mode); order.push('api', 'admin'); },
      verifyRoutes: async () => { order.push('tls'); return true; },
    });
    expect(order).toEqual(['routes', 'api', 'admin', 'tls']);
  });
  it('does not start consumers after a rejected route configuration', async () => {
    const activate = vi.fn();
    await expect(routedActivation({ applyRoutes: async () => { throw new Error('invalid routes'); }, activate, verifyRoutes: async () => true })).rejects.toThrow('invalid routes');
    expect(activate).not.toHaveBeenCalled();
  });
  it('retains the final TLS gate and propagates component failures', async () => {
    await expect(routedActivation({ applyRoutes: async () => {}, activate: async () => {}, verifyRoutes: async () => false })).rejects.toThrow('TLS readiness');
    const verifyRoutes = vi.fn();
    await expect(routedActivation({ applyRoutes: async () => {}, activate: async () => { throw new Error('component failed'); }, verifyRoutes })).rejects.toThrow('component failed');
    expect(verifyRoutes).not.toHaveBeenCalled();
  });
});
