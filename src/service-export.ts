import { X509Certificate } from 'node:crypto';
import { Header, Parser, type ReadEntry } from 'tar';
import { PlanningBlockedError } from '@treeseed-cordis/sdk';
import { PlanningFailure as Check } from './filesystem.js';
/** Bounded inspection of Docker's tar stdout; never extracts or imports archive contents. */
export class AuthorityArchive {
    private readonly parser: Parser;
    private count = 0;
    private invalid = false;
    private bytes = 0;
    private size = 0;
    private chunks: Buffer[] = [];
    private resolve: ((bytes: Buffer) => void) | null = null;
    private reject: ((error: Error) => void) | null = null;
    private constructor(private readonly input: Buffer, private readonly filename: string) { this.parser = new Parser({ strict: true, maxMetaEntrySize: 4096, maxDecompressionRatio: 1, onReadEntry: this.entry.bind(this) }); }
    static async read(input: Uint8Array, filename: string): Promise<Buffer> {
        try {
            Check.require(input.byteLength <= 1024 * 1024 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(filename), 'INVALID_AUTHORITY_ARCHIVE');
            const bytes = Buffer.from(input);
            this.framing(bytes);
            return await new AuthorityArchive(bytes, filename).read();
        } catch { return Check.block('INVALID_AUTHORITY_ARCHIVE'); }
    }
    private static framing(bytes: Buffer): void {
        Check.require(bytes.length >= 1536 && bytes.length % 512 === 0, 'INVALID_AUTHORITY_ARCHIVE');
        let offset = 0;
        while (offset + 512 <= bytes.length) {
            const header = new Header(bytes, offset);
            if (header.nullBlock) {
                Check.require(bytes.length - offset >= 1024, 'INVALID_AUTHORITY_ARCHIVE');
                for (let index = offset; index < bytes.length; index++) Check.require(bytes[index] === 0, 'INVALID_AUTHORITY_ARCHIVE');
                return;
            }
            const size = header.size;
            Check.require(header.cksumValid && typeof size === 'number' && Number.isSafeInteger(size) && size >= 0 && size <= 128 * 1024, 'INVALID_AUTHORITY_ARCHIVE');
            Check.require(['File', 'OldFile', 'ExtendedHeader', 'GlobalExtendedHeader'].includes(header.type) && (!header.type.includes('ExtendedHeader') || size <= 4096), 'INVALID_AUTHORITY_ARCHIVE');
            offset += 512 + Math.ceil(size / 512) * 512;
            Check.require(offset <= bytes.length - 1024, 'INVALID_AUTHORITY_ARCHIVE');
        }
        Check.block('INVALID_AUTHORITY_ARCHIVE');
    }
    private read(): Promise<Buffer> { return new Promise(this.start.bind(this)); }
    private start(resolve: (bytes: Buffer) => void, reject: (error: Error) => void): void { this.resolve = resolve; this.reject = reject; this.parser.on('error', this.error.bind(this)); this.parser.once('end', this.end.bind(this)); this.parser.end(this.input); }
    private entry(entry: ReadEntry): void {
        this.count++;
        if (this.count !== 1 || entry.path !== this.filename || !['File', 'OldFile'].includes(entry.type) || entry.size < 1 || entry.size > 128 * 1024 || entry.linkpath) { this.invalid = true; entry.resume(); return; }
        this.size = entry.size; entry.on('data', this.data.bind(this));
    }
    private data(bytes: Buffer): void { this.bytes += bytes.length; if (this.bytes > 128 * 1024) this.invalid = true; else this.chunks.push(bytes); }
    private error(): void { this.invalid = true; this.reject?.(new PlanningBlockedError([{ code: 'INVALID_AUTHORITY_ARCHIVE', message: 'Public authority archive validation failed.' }])); }
    static certificate(input: Uint8Array): Buffer {
        try {
            Check.require(input.byteLength > 0 && input.byteLength <= 128 * 1024, 'INVALID_AUTHORITY_ARCHIVE');
            const bytes = Buffer.from(input), text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), match = /^-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----\r?\n?$/.exec(text);
            Check.require(match, 'INVALID_AUTHORITY_ARCHIVE');
            const encoded = match[1]!.replace(/[\r\n]/g, ''), der = Buffer.from(encoded, 'base64'), certificate = new X509Certificate(bytes);
            Check.require(der.toString('base64') === encoded && certificate.raw.equals(der) && certificate.ca && Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now(), 'INVALID_AUTHORITY_ARCHIVE');
            return bytes;
        } catch { return Check.block('INVALID_AUTHORITY_ARCHIVE'); }
    }
    private end(): void { try { Check.require(!this.invalid && this.count === 1 && this.bytes === this.size, 'INVALID_AUTHORITY_ARCHIVE'); this.resolve!(AuthorityArchive.certificate(Buffer.concat(this.chunks))); } catch { this.error(); } }
}
