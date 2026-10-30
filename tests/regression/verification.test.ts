import { test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { VerificationPartitions } from '../../scripts/verification.js';

class VerificationPartitionTests {
  private static readonly groups = [
    'build-registered',
    'foundation',
    'git-installed',
    'kata',
    'registered',
    'runtime',
    'sources',
    'transitions',
  ];
  private static readonly assigned = {
    registered: [
      'tests/acceptance/git-registered-install.test.ts',
      'tests/acceptance/registered-install.test.ts',
    ],
    'build-registered': ['tests/acceptance/build-registered-install.test.ts'],
    'git-installed': ['tests/acceptance/git-install.test.ts'],
    transitions: [
      'tests/acceptance/service-restart.test.ts',
      'tests/acceptance/service-retained-plan.test.ts',
    ],
    sources: [
      'tests/acceptance/git-build.test.ts',
      'tests/acceptance/git-source.test.ts',
      'tests/acceptance/npm-source.test.ts',
    ],
  };
  workflow(): void {
    const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');
    expect(workflow).toContain('needs: [checks, smoke]');
    expect(workflow).toContain(
      'partition: [foundation, kata, transitions, sources, runtime, git-installed, registered, build-registered]',
    );
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain("needs.smoke.result == 'success'");
    expect(workflow).toContain('bun scripts/verification.ts smoke ${{ matrix.partition }}');
    expect(workflow).toContain("(matrix.partition == 'foundation' || matrix.partition == 'kata')");
  }
  inventory(): void {
    const result = spawnSync(process.execPath, ['scripts/verification.ts', 'inventory'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const parts = JSON.parse(result.stdout) as Record<string, string[]>;
    this.discovery(parts);
    this.ownership(parts);
    const invalid = spawnSync(process.execPath, ['scripts/verification.ts', 'smoke', 'unknown'], {
      encoding: 'utf8',
    });
    expect(invalid.status).toBe(2);
    expect(invalid.stdout).toBe('');
  }
  private discovery(parts: Record<string, string[]>): void {
    expect(Object.keys(parts).sort()).toEqual(VerificationPartitionTests.groups);
    const all = Object.values(parts).flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(this.files().sort());
  }
  private ownership(parts: Record<string, string[]>): void {
    for (const [group, files] of Object.entries(VerificationPartitionTests.assigned))
      expect(parts[group]).toEqual(files);
    const names = readdirSync('tests/acceptance');
    expect(parts.runtime).toEqual(
      [
        'tests/acceptance/service-application.test.ts',
        'tests/acceptance/service-authority.test.ts',
        ...names
          .filter(VerificationPartitionTests.installFile)
          .map(VerificationPartitionTests.path),
      ].sort(),
    );
    expect(parts.kata).toEqual(
      names.filter(VerificationPartitionTests.kataFile).map(VerificationPartitionTests.path).sort(),
    );
  }
  validation(): void {
    const files = this.files();
    this.future(files);
    this.required(files);
    expect(
      VerificationPartitions.inventory.bind(VerificationPartitions, [...files, files[0]!]),
    ).toThrow();
    expect(
      VerificationPartitions.inventory.bind(VerificationPartitions, ['../foreign.test.ts']),
    ).toThrow();
  }
  private future(files: string[]): void {
    expect(
      VerificationPartitions.inventory([...files, 'tests/acceptance/future-install.test.ts'])
        .runtime,
    ).toContain('tests/acceptance/future-install.test.ts');
    expect(
      VerificationPartitions.inventory([...files, 'tests/acceptance/future.test.ts']).foundation,
    ).toContain('tests/acceptance/future.test.ts');
    expect(
      VerificationPartitions.inventory([...files, 'tests/acceptance/kata-future.test.ts']).kata,
    ).toContain('tests/acceptance/kata-future.test.ts');
  }
  private required(files: string[]): void {
    for (const file of [
      'tests/acceptance/git-source.test.ts',
      'tests/acceptance/service-application.test.ts',
      'tests/acceptance/service-restart.test.ts',
      'tests/acceptance/kata-backend.test.ts',
    ])
      expect(
        VerificationPartitions.inventory.bind(
          VerificationPartitions,
          files.filter(VerificationPartitionTests.other.bind(null, file)),
        ),
      ).toThrow();
  }
  private static other(omitted: string, name: string): boolean {
    return name !== omitted;
  }
  private files(): string[] {
    return readdirSync('tests/acceptance')
      .filter(VerificationPartitionTests.testFile)
      .map(VerificationPartitionTests.path);
  }
  private static kataFile(name: string): boolean {
    return name.startsWith('kata-') && name.endsWith('.test.ts');
  }
  private static installFile(name: string): boolean {
    return (
      name.endsWith('-install.test.ts') &&
      ![
        'git-install.test.ts',
        'registered-install.test.ts',
        'git-registered-install.test.ts',
        'build-registered-install.test.ts',
      ].includes(name)
    );
  }
  private static testFile(name: string): boolean {
    return name.endsWith('.test.ts');
  }
  private static path(name: string): string {
    return 'tests/acceptance/' + name;
  }
}
const suite = new VerificationPartitionTests();
test(
  'regression: aggregate CI gate requires every exhaustive smoke partition',
  suite.workflow.bind(suite),
);
test(
  'regression: partition inventory is disjoint exhaustive and rejects unknown groups before execution',
  suite.inventory.bind(suite),
);
test(
  'regression: inventory validates new files and refuses duplicate omitted or foreign membership',
  suite.validation.bind(suite),
);
