import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as program from '../support/plugin-installation-fixture.js';
class DockerDiagnosticUnit {
  invalid(): void {
    const directory = mkdtempSync(join(tmpdir(), 'docker-invalid-'));
    const file = join(directory, 'input.json');
    const diagnostic = Reflect.get(program, 'DockerPrerequisiteFixture') as {
      report(file: string): string;
    };
    assert.equal(typeof diagnostic, 'function');
    assert.equal(diagnostic.report(file), 'docker-readback(context:unavailable)');
    for (const value of [
      '{not-json',
      JSON.stringify({ configuration: { engineContext: 'secret-output-canary /run/private' } }),
    ]) {
      writeFileSync(file, value);
      assert.equal(diagnostic.report(file), 'docker-readback(context:unavailable)');
    }
  }
}
const suite = new DockerDiagnosticUnit();
test(
  'unit: malformed fixture context diagnostics expose only fixed unavailable state',
  suite.invalid.bind(suite),
);
