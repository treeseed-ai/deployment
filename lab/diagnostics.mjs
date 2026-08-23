import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

const root = '/manager', maximumBytes = 256 * 1024;
const sensitive = /(?:authorization|credential|key|password|secret|token)/iu;

function redact(value, key = '') {
	if (sensitive.test(key)) return '[REDACTED]';
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
	return value;
}

function jsonFile(name) {
	const path = `${root}/${name}`;
	if (!existsSync(path)) return null;
	const value = readFileSync(path);
	if (value.length > maximumBytes) return { truncated: true };
	try { return redact(JSON.parse(value.toString('utf8'))); } catch { return { malformed: true }; }
}

function events() {
	const path = `${root}/events.ndjson`;
	if (!existsSync(path)) return [];
	const value = readFileSync(path); const bounded = value.subarray(Math.max(0, value.length - maximumBytes)).toString('utf8');
	return bounded.split('\n').filter(Boolean).slice(-100).flatMap((line) => { try { return [redact(JSON.parse(line))]; } catch { return []; } });
}

createServer((request, response) => {
	response.setHeader('content-type', 'application/json'); response.setHeader('cache-control', 'no-store');
	if (request.url === '/healthz') return response.end('{"ok":true}\n');
	if (request.url !== '/' && request.url !== '/api/status') { response.statusCode = 404; return response.end('{"ok":false,"error":"not_found"}\n'); }
	response.end(`${JSON.stringify({ ok: true, receipt: jsonFile('current-receipt.json'), updates: jsonFile('update-state.json'), events: events() })}\n`);
}).listen(8080, '0.0.0.0');
