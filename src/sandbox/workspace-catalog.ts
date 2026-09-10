import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sourceWorkspaceAuthorizationSchema, sourceWorkspaceKeySchema,
	type SourceWorkspaceAuthorization, type SourceWorkspaceKey } from '@treeseed/sdk/capacity-provider/sandbox';

export function sourceWorkspaceId(input: SourceWorkspaceKey) {
	return createHash('sha256').update(JSON.stringify(sourceWorkspaceKeySchema.parse(input))).digest('hex');
}

interface ImageRow {
	id: string; source_json: string; state: 'missing' | 'building' | 'ready' | 'failed' | 'deleting';
	job_id: string | null; parent_id: string | null; digest: string | null; bytes: number | null; depth: number;
}

/** Manager-owned local metadata. Transactions are short; Git/QEMU work occurs outside them. */
export class WorkspaceCatalog {
	private readonly db: DatabaseSync;
	constructor(path: string, readonly maxChainDepth = 4) {
		if (!Number.isSafeInteger(maxChainDepth) || maxChainDepth < 1 || maxChainDepth > 16) throw new Error('Invalid workspace chain limit.');
		this.db = new DatabaseSync(path);
		this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
			CREATE TABLE IF NOT EXISTS workspace_images (
				id TEXT PRIMARY KEY, source_json TEXT NOT NULL, state TEXT NOT NULL, job_id TEXT,
				parent_id TEXT REFERENCES workspace_images(id), digest TEXT, bytes INTEGER, depth INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS workspace_leases (
				id TEXT PRIMARY KEY, image_id TEXT NOT NULL REFERENCES workspace_images(id), authorization_id TEXT NOT NULL,
				provider_id TEXT NOT NULL, assignment_id TEXT NOT NULL, attempt INTEGER NOT NULL, mode TEXT NOT NULL,
				publication TEXT NOT NULL, state TEXT NOT NULL, expires_at TEXT NOT NULL, result_artifact_id TEXT,
				UNIQUE(provider_id, assignment_id, attempt)
			);`);
	}
	close() { this.db.close(); }
	private transaction<T>(run: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');
		try { const result = run(); this.db.exec('COMMIT'); return result; }
		catch (error) { this.db.exec('ROLLBACK'); throw error; }
	}
	image(id: string): ImageRow | undefined {
		return this.db.prepare('SELECT * FROM workspace_images WHERE id=?').get(id) as unknown as ImageRow | undefined;
	}
	/** Only current API authority can extend an existing lease; expiry cannot be undone by replay. */
	renew(leaseId: string, input: SourceWorkspaceAuthorization, now = new Date()) {
		const authorization = sourceWorkspaceAuthorizationSchema.parse(input);
		if (Date.parse(authorization.expiresAt) <= now.getTime() || Date.parse(authorization.issuedAt) > now.getTime()) throw new Error('Workspace authority is not current.');
		return this.transaction(() => {
			const prior = this.db.prepare('SELECT * FROM workspace_leases WHERE id=?').get(leaseId);
			if (!prior || prior.state !== 'active' || Date.parse(String(prior.expires_at)) <= now.getTime()
				|| prior.image_id !== sourceWorkspaceId(authorization.source) || prior.provider_id !== authorization.providerId
				|| prior.assignment_id !== authorization.assignmentId || prior.attempt !== authorization.attempt
				|| prior.mode !== authorization.mode || prior.publication !== authorization.publication) throw new Error('Workspace renewal changed authority or targets an expired lease.');
			if (Date.parse(authorization.expiresAt) < Date.parse(String(prior.expires_at))) throw new Error('Workspace renewal cannot shorten an active lease.');
			this.db.prepare('UPDATE workspace_leases SET authorization_id=?,expires_at=? WHERE id=?')
				.run(authorization.id, authorization.expiresAt, leaseId);
		});
	}
	/** Filesystem writes never imply source publication permission. Check again before candidate acceptance. */
	assertCandidateAuthority(leaseId: string, authorizationId: string, now = new Date()) {
		const lease = this.db.prepare('SELECT * FROM workspace_leases WHERE id=?').get(leaseId);
		if (!lease || lease.state !== 'active' || lease.mode !== 'work' || lease.publication !== 'candidate-only'
			|| lease.authorization_id !== authorizationId || Date.parse(String(lease.expires_at)) <= now.getTime()) {
			throw new Error('Workspace has no current candidate publication authority.');
		}
	}
	ensure(input: SourceWorkspaceKey) {
		const source = sourceWorkspaceKeySchema.parse(input), id = sourceWorkspaceId(source);
		this.db.prepare("INSERT INTO workspace_images(id,source_json,state) VALUES(?,?,'missing') ON CONFLICT(id) DO NOTHING")
			.run(id, JSON.stringify(source));
		return this.image(id)!;
	}
	claimBuild(id: string, parentId: string | null = null) {
		return this.transaction(() => {
			const image = this.image(id);
			if (!image || !['missing', 'failed'].includes(image.state)) throw new Error('Workspace build is unavailable or already owned.');
			const parent = parentId ? this.image(parentId) : null;
			if (parentId && (!parent || parent.state !== 'ready')) throw new Error('Workspace parent is not ready.');
			if (parent) {
				const source = sourceWorkspaceKeySchema.parse(JSON.parse(image.source_json));
				const parentSource = sourceWorkspaceKeySchema.parse(JSON.parse(parent.source_json));
				if (JSON.stringify({ ...source, commit: '' }) !== JSON.stringify({ ...parentSource, commit: '' })) throw new Error('Workspace parent crosses a source security domain.');
				if (parent.depth + 1 > this.maxChainDepth) throw new Error('Workspace requires a new flattened base.');
			}
			const jobId = randomUUID();
			this.db.prepare("UPDATE workspace_images SET state='building',job_id=?,parent_id=?,depth=? WHERE id=?")
				.run(jobId, parentId, parent ? parent.depth + 1 : 0, id);
			return { jobId, image: this.image(id)! };
		});
	}
	/** Called only after the isolated builder is stopped and its independent verification passed. */
	publish(id: string, jobId: string, evidence: { digest: string; bytes: number; commit: string;
		clean: boolean; filesystemVerified: boolean; builderStopped: boolean }) {
		if (!/^sha256:[a-f0-9]{64}$/u.test(evidence.digest) || !Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1
			|| !evidence.clean || !evidence.filesystemVerified || !evidence.builderStopped) throw new Error('Incomplete workspace verification.');
		return this.transaction(() => {
			const image = this.image(id);
			if (!image || image.state !== 'building' || image.job_id !== jobId) throw new Error('Workspace build ownership changed.');
			if (sourceWorkspaceKeySchema.parse(JSON.parse(image.source_json)).commit !== evidence.commit) throw new Error('Workspace commit does not match its cache key.');
			this.db.prepare("UPDATE workspace_images SET state='ready',job_id=NULL,digest=?,bytes=? WHERE id=?")
				.run(evidence.digest, evidence.bytes, id);
			return this.image(id)!;
		});
	}
	failBuild(id: string, jobId: string) {
		return Number(this.db.prepare("UPDATE workspace_images SET state='failed',job_id=NULL WHERE id=? AND job_id=? AND state='building'").run(id, jobId).changes) === 1;
	}
	/** The trusted caller must resolve live Identity/Vault authority immediately before this call. */
	lease(input: SourceWorkspaceAuthorization, now = new Date()) {
		const authorization = sourceWorkspaceAuthorizationSchema.parse(input);
		if (Date.parse(authorization.expiresAt) <= now.getTime() || Date.parse(authorization.issuedAt) > now.getTime()) throw new Error('Workspace authority is not current.');
		return this.transaction(() => {
			const image = this.image(sourceWorkspaceId(authorization.source));
			if (!image || image.state !== 'ready') throw new Error('Exact workspace is not READY.');
			const prior = this.db.prepare('SELECT * FROM workspace_leases WHERE provider_id=? AND assignment_id=? AND attempt=?')
				.get(authorization.providerId, authorization.assignmentId, authorization.attempt);
			if (prior) {
				if (prior.state !== 'active' || Date.parse(String(prior.expires_at)) <= now.getTime() || prior.authorization_id !== authorization.id || prior.image_id !== image.id
					|| prior.mode !== authorization.mode || prior.publication !== authorization.publication) throw new Error('Workspace lease replay does not match active custody.');
				return { id: String(prior.id), imageId: image.id, noop: true };
			}
			const id = randomUUID();
			this.db.prepare(`INSERT INTO workspace_leases(id,image_id,authorization_id,provider_id,assignment_id,attempt,mode,publication,state,expires_at)
				VALUES(?,?,?,?,?,?,?,?,'active',?)`).run(id, image.id, authorization.id, authorization.providerId,
				authorization.assignmentId, authorization.attempt, authorization.mode, authorization.publication, authorization.expiresAt);
			return { id, imageId: image.id, noop: false };
		});
	}
	recordDurableResult(leaseId: string, artifactId: string) {
		if (!artifactId || artifactId.length > 256) throw new Error('A durable result artifact is required.');
		const changed = this.db.prepare("UPDATE workspace_leases SET result_artifact_id=? WHERE id=? AND state IN ('active','quarantined') AND (result_artifact_id IS NULL OR result_artifact_id=?)")
			.run(artifactId, leaseId, artifactId).changes;
		if (!changed) throw new Error('Workspace result custody changed.');
	}
	release(leaseId: string, teardownVerified: boolean) {
		if (!teardownVerified) throw new Error('Workspace teardown must be verified.');
		const changed = this.db.prepare("UPDATE workspace_leases SET state='released' WHERE id=? AND state IN ('active','quarantined') AND result_artifact_id IS NOT NULL").run(leaseId).changes;
		if (!changed) throw new Error('Workspace has no durable result or is not active.');
	}
	/** Expiry is not teardown evidence. Quarantine retains image ancestry until recovery verifies it. */
	quarantineExpired(now = new Date()) {
		return Number(this.db.prepare("UPDATE workspace_leases SET state='quarantined' WHERE state='active' AND expires_at<=?").run(now.toISOString()).changes);
	}
	claimDeletion(id: string) {
		return this.transaction(() => {
			const image = this.image(id);
			if (!image || !['ready', 'failed', 'missing'].includes(image.state)) return false;
			if (this.db.prepare('SELECT id FROM workspace_images WHERE parent_id=? LIMIT 1').get(id)
				|| this.db.prepare("SELECT id FROM workspace_leases WHERE image_id=? AND state!='released' LIMIT 1").get(id)) return false;
			this.db.prepare("UPDATE workspace_images SET state='deleting' WHERE id=?").run(id); return true;
		});
	}
	finishDeletion(id: string) {
		return this.transaction(() => {
			if (this.image(id)?.state !== 'deleting') throw new Error('Workspace deletion is not owned.');
			this.db.prepare("DELETE FROM workspace_leases WHERE image_id=? AND state='released'").run(id);
			this.db.prepare("DELETE FROM workspace_images WHERE id=? AND state='deleting'").run(id);
		});
	}
}
