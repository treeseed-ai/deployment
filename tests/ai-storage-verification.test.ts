import { describe, expect, it } from 'vitest';
import { verifyAiStorage } from '../src/supervisor/ai/storage-verification.js';
import { nodeStorageProbe, pythonStorageProbe } from '../src/supervisor/ai/storage-probes.js';
import { component } from './fixtures.js';
import { spawnSync } from 'node:child_process';

const releases = ['ai-inference','ai-training'].map(id => {
	const value = component(id, 'development', 'a');
	value.runtime.services = (id === 'ai-inference' ? ['inference-api'] : ['training-api','training-artifact']).map(name => ({...value.runtime.services[0]!, id:name,composeService:name}));
	return value;
});
const key = '.treeseed-acceptance/00000000-0000-4000-8000-000000000000/probe';
describe('fixed managed AI storage acceptance', () => {
	it('parses both fixed programs without running training or accessing credentials', () => {
		expect(spawnSync(process.execPath, ['--check','--input-type=module'], { input:nodeStorageProbe, encoding:'utf8' }).status).toBe(0);
		expect(spawnSync('python3', ['-c','import ast,sys; ast.parse(sys.stdin.read())'], {input:pythonStorageProbe,encoding:'utf8'}).status).toBe(0);
	});
	it('runs only fixed programs in exact accepted images and emits redacted results', () => {
		const commands: string[][] = [];
		let selected = releases[0]!;
		const result = verifyAiStorage({ components: releases, capture: args => {
			commands.push(args);
			if (args[0] === 'ps') { selected = releases.find(value => args.includes(`label=com.docker.compose.project=${value.runtime.compose.projectName}`))!;return 'abcdef123456'; }
			if (args[0] === 'inspect') return `${selected.images[0]!.repository}@${selected.images[0]!.digest}`;
			return JSON.stringify({ok:true,cleanup:true,phase:'complete',key,secret:'must-not-escape'});
		} });
		expect(result.ok).toBe(true); expect(commands.filter(args => args[0] === 'exec')).toHaveLength(3);
		expect(JSON.stringify(result)).not.toContain('must-not-escape');
		expect(commands.filter(args => args[0] === 'exec').every(args => [nodeStorageProbe,pythonStorageProbe].includes(args.at(-1)!))).toBe(true);
		expect(result.trainingExecuted).toBe(false);
	});
	it('rejects drifted images without executing inside them', () => {
		const commands: string[][] = [];
		const result = verifyAiStorage({components:releases,capture:args => { commands.push(args);return args[0] === 'ps' ? 'abcdef123456' : 'unaccepted:latest'; }});
		expect(result.ok).toBe(false); expect(commands.some(args => args[0] === 'exec')).toBe(false);
	});
	it('bounds both programs and includes the same four isolation checks', () => {
		for (const program of [nodeStorageProbe,pythonStorageProbe]) for (const check of ['object-isolation','team-isolation','action-isolation','workload-isolation']) expect(program).toContain(check);
		expect(nodeStorageProbe).toContain('process.exit(124),75000'); expect(pythonStorageProbe).toContain('signal.alarm(75)');
	});
});
