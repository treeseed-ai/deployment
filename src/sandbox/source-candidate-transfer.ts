import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { sourceCandidateAttestationSchema, sourceCandidateChunkBytes, sourceCandidateReceiptSchema,
  type SandboxAssignment, type SourceWorkspaceAuthorization, type SourceCandidateAttestation } from '@treeseed/sdk/capacity-provider/sandbox';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function checkedFile(path: string, bytes: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o222)
      || stat.size !== bytes || await realpath(path) !== path) throw new Error('Candidate file is not immutable manager custody.');
    return file;
  } catch (error) { await file.close(); throw error; }
}

/** Reads only an independently verified, frozen manager file. Never accepts a caller/guest path. */
export async function describeCandidateTransfer(input: {
  assignment: Pick<SandboxAssignment, 'assignmentId' | 'attempt' | 'providerId'>;
  leaseId: string; authorization: SourceWorkspaceAuthorization; commit: string; parentCandidateId: string | null;
  bundlePath: string; bytes: number; digest: string; verifiedAt: string;
}) {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > sourceCandidateChunkBytes * 1024) throw new Error('Candidate exceeds bounded transfer size.');
  const file = await checkedFile(input.bundlePath, input.bytes), chunks: string[] = [], hash = createHash('sha256');
  try {
    for (let offset = 0; offset < input.bytes; offset += sourceCandidateChunkBytes) {
      const buffer = Buffer.alloc(Math.min(sourceCandidateChunkBytes, input.bytes - offset));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new Error('Candidate changed during transfer indexing.');
      chunks.push(`sha256:${sha(buffer)}`); hash.update(buffer);
    }
  } finally { await file.close(); }
  if (`sha256:${hash.digest('hex')}` !== input.digest) throw new Error('Candidate differs from independent verifier digest.');
  return sourceCandidateAttestationSchema.parse({ schemaVersion: 'treeseed.source-candidate-attestation/v1', ...input.assignment,
    leaseId: input.leaseId, source: input.authorization.source, commit: input.commit, parentCandidateId: input.parentCandidateId,
    bundle: { digest: input.digest, bytes: input.bytes, chunks },
    verification: { clean: true, objectClosure: true, ancestry: true, isolatedVerifier: true, executionStopped: true, verifierStopped: true }, verifiedAt: input.verifiedAt });
}
export async function readCandidateTransferChunk(path: string, candidate: SourceCandidateAttestation, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= candidate.bundle.chunks.length) throw new Error('Candidate chunk is outside its manifest.');
  const file = await checkedFile(path, candidate.bundle.bytes);
  try {
    const buffer = Buffer.alloc(Math.min(sourceCandidateChunkBytes, candidate.bundle.bytes - index * sourceCandidateChunkBytes));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, index * sourceCandidateChunkBytes);
    if (bytesRead !== buffer.length || `sha256:${sha(buffer)}` !== candidate.bundle.chunks[index]) throw new Error('Candidate chunk changed after verification.');
    return { index, digest: candidate.bundle.chunks[index], content: buffer.toString('base64') };
  } finally { await file.close(); }
}
/** The trusted provider host forwards API read-back. Guest relay credentials cannot call acceptance. */
export function assertCandidateAcceptance(candidate: SourceCandidateAttestation, value: unknown) {
  const receipt = sourceCandidateReceiptSchema.parse(value), id = `source-candidate-${sha(canonical(candidate))}`;
  if (receipt.id !== id || receipt.bundle.artifactId !== id || receipt.leaseId !== candidate.leaseId
    || receipt.commit !== candidate.commit || canonical(receipt.source) !== canonical(candidate.source)
    || receipt.parentCandidateId !== candidate.parentCandidateId || receipt.bundle.bytes !== candidate.bundle.bytes
    || receipt.bundle.digest !== candidate.bundle.digest) throw new Error('API candidate receipt does not match verified source custody.');
  return receipt;
}
