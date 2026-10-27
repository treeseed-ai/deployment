import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';

interface Violation { file: string; symbol: string; fingerprint: string; }
interface Report { success: boolean; errors: string[]; violations: Violation[]; }
interface Policy { baselineCommit: string; violations: Violation[]; exceptions: object[]; }

class ReadabilityFixture {
  readonly root = mkdtempSync(join(tmpdir(), 'readable-capabilities-'));
  readonly helper = resolve('.agents/skills/release-workflow/scripts/source-readability.ts');

  constructor(source = 'export class Provider { run(): number { return 1; } }') {
    mkdirSync(join(this.root, 'src'));
    this.source(source);
    this.git(['init', '-q']);
    this.git(['add', '.']);
    this.git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--no-gpg-sign', '-qm', 'fixture baseline']);
    this.git(['update-ref', 'refs/remotes/origin/cordis', 'HEAD']);
    this.capture();
  }

  private git(args: string[]): string {
    const result = spawnSync('git', args, { cwd: this.root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Git fixture failed: ' + result.stderr);
    return result.stdout.trim();
  }

  private capture(): void {
    const result = this.run(['--capture', this.git(['rev-parse', 'HEAD'])]);
    expect(result.status, result.stderr).toBe(0);
  }

  run(args: string[] = []): SpawnSyncReturns<string> {
    return spawnSync(process.execPath, [this.helper, '--root', this.root, ...args], {
      encoding: 'utf8', timeout: 30000,
    });
  }

  check(): Report {
    const result = this.run(['--json']);
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout) as Report;
    expect(result.status).toBe(report.success ? 0 : 1);
    return report;
  }

  source(value: string): void { writeFileSync(join(this.root, 'src/provider.ts'), value); }
  policy(): Policy { return JSON.parse(readFileSync(join(this.root, '.readability.json'), 'utf8')); }
  save(value: Policy): void { writeFileSync(join(this.root, '.readability.json'), JSON.stringify(value)); }
  close(): void { rmSync(this.root, { recursive: true, force: true }); }
}

class ReadabilityPrograms {
  static longMethod(name = 'run'): string {
    const statements = [];
    for (let index = 0; index < 23; index++) statements.push('    this.step();');
    return 'export class Provider {\n  ' + name + '(): void {\n' + statements.join('\n') +
      '\n  }\n  step(): void {}\n}\n';
  }

  unchangedDebt(): void {
    const fixture = new ReadabilityFixture(ReadabilityPrograms.longMethod());
    try { expect(fixture.check().success).toBe(true); }
    finally { fixture.close(); }
  }

  changedMethod(): void {
    const fixture = new ReadabilityFixture(ReadabilityPrograms.longMethod());
    try {
      fixture.source(ReadabilityPrograms.longMethod().replace('this.step();', 'this.step();\n    this.step();'));
      expect(fixture.check().errors.join('\n')).toContain('METHOD_LENGTH');
    } finally { fixture.close(); }
  }

  newMethod(): void {
    const fixture = new ReadabilityFixture();
    try {
      fixture.source(ReadabilityPrograms.longMethod());
      expect(fixture.check().errors.join('\n')).toContain('METHOD_LENGTH');
    } finally { fixture.close(); }
  }

  compressedStatements(): void {
    const fixture = new ReadabilityFixture();
    try {
      fixture.source('export class Provider { run(): number { const value = 1; return value; } }');
      expect(fixture.check().errors.join('\n')).toContain('COMPRESSED_STATEMENTS');
    } finally { fixture.close(); }
  }

  baselineTampering(): void {
    const fixture = new ReadabilityFixture(ReadabilityPrograms.longMethod());
    try {
      const policy = fixture.policy();
      policy.violations = [];
      fixture.save(policy);
      expect(fixture.check().errors.join('\n')).toContain('BASELINE_MISMATCH');
    } finally { fixture.close(); }
  }

  exactException(): void {
    const fixture = new ReadabilityFixture();
    try {
      fixture.source(ReadabilityPrograms.longMethod());
      const violation = fixture.check().violations[0]!;
      const policy = fixture.policy();
      policy.exceptions = [{ ...violation, issue: 1, reason: 'Keep this fixture transition coherent for review.' }];
      fixture.save(policy);
      expect(fixture.check().success).toBe(true);
      fixture.source(ReadabilityPrograms.longMethod('other'));
      expect(fixture.check().errors.join('\n')).toContain('STALE_EXCEPTION');
    } finally { fixture.close(); }
  }

  declarativeData(): void {
    const fixture = new ReadabilityFixture();
    try {
      const values = [];
      for (let index = 0; index < 100; index++) values.push('    "value-' + index + '",');
      fixture.source('export class Provider {\n  static readonly values = [\n' + values.join('\n') + '\n  ];\n}');
      expect(fixture.check().success).toBe(true);
    } finally { fixture.close(); }
  }

  constructorsAndAccessors(): void {
    const fixture = new ReadabilityFixture();
    try {
      const source = ReadabilityPrograms.longMethod();
      fixture.source(source.replace('run(): void', 'constructor()'));
      expect(fixture.check().errors.join('\n')).toContain('Provider.constructor');
      fixture.source(source.replace('run(): void', 'get result(): void'));
      expect(fixture.check().errors.join('\n')).toContain('Provider.get result');
    } finally { fixture.close(); }
  }

  provenance(): void {
    const fixture = new ReadabilityFixture();
    try {
      const policy = fixture.policy();
      policy.baselineCommit = '0'.repeat(40);
      fixture.save(policy);
      expect(fixture.check().success).toBe(false);
      expect(fixture.run(['--capture', policy.baselineCommit]).status).toBe(1);
    } finally { fixture.close(); }
  }

  unusedException(): void {
    const fixture = new ReadabilityFixture();
    try {
      const policy = fixture.policy();
      policy.exceptions = [{ file: 'src/provider.ts', symbol: 'Provider.missing',
        fingerprint: '0'.repeat(64), issue: 1, reason: 'This exemption has no matching violating method.' }];
      fixture.save(policy);
      expect(fixture.check().errors.join('\n')).toContain('STALE_EXCEPTION');
    } finally { fixture.close(); }
  }
}

const suite = new ReadabilityPrograms();
test('acceptance: readability gate preserves exact unchanged integration debt', suite.unchangedDebt.bind(suite));
test('acceptance: changed long methods lose baseline grandfathering', suite.changedMethod.bind(suite));
test('acceptance: new long methods fail canonical measurement', suite.newMethod.bind(suite));
test('acceptance: compressed statements cannot evade readable layout', suite.compressedStatements.bind(suite));
test('acceptance: baseline inventory tampering fails verified Git read-back', suite.baselineTampering.bind(suite));
test('acceptance: reviewed exact exceptions become invalid after source changes', suite.exactException.bind(suite));
test('acceptance: declarative data remains outside the behavioral line limit', suite.declarativeData.bind(suite));
test('acceptance: constructors and accessors share the executable method gate', suite.constructorsAndAccessors.bind(suite));
test('acceptance: changing baseline provenance cannot grandfather feature code', suite.provenance.bind(suite));
test('acceptance: unused exemptions fail instead of silently accumulating', suite.unusedException.bind(suite));
