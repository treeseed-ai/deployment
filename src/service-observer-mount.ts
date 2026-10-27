import { fstatSync, lstatSync, type Stats } from 'node:fs';
import { CanonicalJson, type ServicePlan, type ServiceInstance } from '@treeseed-cordis/sdk';
import { SafeDirectory, PlanningFailure as Check, StrictJson } from './filesystem.js';
import { ServicePlanStore } from './service-plan.js';
/** A scoped read-only mount grant. It never opens the owner control directory. */
export class ServiceObserverMount {
    static readonly target = '/run/cordis-host';
    private readonly socket: Stats; private readonly directoryIdentity: Stats; readonly digest: string;
    private constructor(private readonly directory: SafeDirectory) {
        try { this.directoryIdentity = fstatSync(directory.fd); SafeDirectory.owner(this.directoryIdentity, true); this.socket = lstatSync(directory.childPath('host.sock')); this.verify(); this.digest = CanonicalJson.digest({ directory: { dev: this.directoryIdentity.dev, ino: this.directoryIdentity.ino }, socket: { dev: this.socket.dev, ino: this.socket.ino }, target: ServiceObserverMount.target }); } catch (error) { directory.close(); throw error; }
    }
    private static overlaps(path: string): boolean { const target = this.target; return path === target || path.startsWith(target + '/') || target.startsWith(path.replace(/\/$/, '') + '/'); }
    static open(plan: ServicePlan, service: ServiceInstance): ServiceObserverMount | null {
        if (!service.definition.workerSocket) return null;
        Check.require(plan.composition.profile.workerSocketServiceId === service.serviceId && service.definition.user === 'installation-owner' && plan.runtimeBindings?.[service.serviceId], 'OBSERVER_MOUNT_GRANT');
        for (const volume of service.definition.volumes) Check.require(!this.overlaps(volume.target), 'OBSERVER_MOUNT_OVERLAP');
        for (const secret of service.definition.secrets) Check.require(!this.overlaps(secret.target), 'OBSERVER_MOUNT_OVERLAP');
        return new ServiceObserverMount(new ServicePlanStore(plan.configuration.installationDirectory).directory('run'));
    }
    static fingerprint(plan: ServicePlan, service: ServiceInstance): string | null { const mount = this.open(plan, service); try { return mount?.digest ?? null; } finally { mount?.close(); } }
    verify(): void {
        this.directory.verify(); const directory = fstatSync(this.directory.fd), socket = lstatSync(this.directory.childPath('host.sock'));
        SafeDirectory.owner(directory, true); Check.require(directory.dev === this.directoryIdentity.dev && directory.ino === this.directoryIdentity.ino && this.directory.entries().sort().join(',') === 'host.sock', 'OBSERVER_DIRECTORY_CHANGED');
        Check.require(directory.ctimeMs === this.directoryIdentity.ctimeMs && socket.isSocket() && !socket.isSymbolicLink() && socket.nlink === 1 && socket.uid === process.getuid?.() && (socket.mode & 0o777) === 0o600 && socket.dev === this.socket.dev && socket.ino === this.socket.ino && socket.ctimeMs === this.socket.ctimeMs, 'OBSERVER_SOCKET_CHANGED');
    }
    source(): string { this.verify(); return this.directory.path; }
    argument(): string { return 'type=bind,source=' + this.source() + ',target=' + ServiceObserverMount.target + ',readonly'; }
    mounted(object: Record<string, unknown>, exactSource?: string): void {
        this.verify(); const labels = StrictJson.object(StrictJson.object(object.Config).Labels); Check.require(labels['ai.treeseed.cordis.observer'] === this.digest && Array.isArray(object.Mounts), 'OBSERVER_MOUNT_CHANGED'); let matched = 0;
        for (const value of object.Mounts) { const mount = StrictJson.object(value); Check.require(typeof mount.Destination === 'string', 'OBSERVER_MOUNT_CHANGED'); if (ServiceObserverMount.overlaps(mount.Destination)) { Check.require(mount.Destination === ServiceObserverMount.target && mount.Type === 'bind' && mount.RW === false && mount.Propagation === 'rprivate' && mount.Source === this.directory.path && (exactSource === undefined || mount.Source === exactSource), 'OBSERVER_MOUNT_CHANGED'); matched++; } }
        Check.require(matched === 1, 'OBSERVER_MOUNT_CHANGED');
    }
    close(): void { this.directory.close(); }
}
