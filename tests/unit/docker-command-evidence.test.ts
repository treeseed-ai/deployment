import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { DockerCommands } from '../../src/docker-commands.js';
import { DockerEvidenceFixture as Fixture } from '../support/docker-evidence-program.js';
class DockerEvidenceUnit {
  missing(): void {
    const original = process.env.PATH;
    try {
      process.env.PATH = '';
      const commands = new DockerCommands();
      assert.equal(commands.execute(['private-argument-canary']), null);
      const result = Fixture.read(commands)!;
      assert.equal(result.kind, 'missing-executable');
      assert.equal(result.category, 'other');
      assert.equal(result.status, null);
      assert.equal(result.signal, null);
      assert(!JSON.stringify(result).includes('private-argument-canary'));
    } finally {
      if (original === undefined) delete process.env.PATH;
      else process.env.PATH = original;
    }
  }
}
const suite = new DockerEvidenceUnit();
test(
  'unit: missing Docker executable evidence contains only fixed categories and no private input',
  suite.missing.bind(suite),
);
