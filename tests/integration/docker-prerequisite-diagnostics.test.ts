import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as program from '../support/npm-source-program.js';
class DockerPrerequisiteDiagnosticsIntegration {
  real(): void {
    const directory = mkdtempSync(join(tmpdir(), 'docker-readback-'));
    const file = join(directory, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({
        configuration: { engineContext: 'default' },
        secret: 'diagnostic-output-canary',
      }),
    );
    const diagnostic = Reflect.get(program, 'DockerPrerequisiteFixture') as {
      report(file: string): string;
    };
    assert.equal(
      typeof diagnostic,
      'function',
      'native fixture must retain safe default Docker read-back',
    );
    const result = diagnostic.report(file);
    assert.match(
      result,
      /^docker-readback\(context:(?:available|unavailable):[0-9]+ms,engine:(?:available|unavailable):[0-9]+ms,compose:(?:available|unavailable):[0-9]+ms\)$/,
    );
    assert(result.length < 200);
    assert(!result.includes(directory));
    assert(!result.includes('diagnostic-output-canary'));
  }
}
const suite = new DockerPrerequisiteDiagnosticsIntegration();
test(
  'integration: default Docker fixture diagnostics retain bounded status without exposing host data',
  suite.real.bind(suite),
  20000,
);
