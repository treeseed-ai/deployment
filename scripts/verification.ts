import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** Development-only test scheduling; every file belongs to exactly one required smoke job. */
export class VerificationPartitions {
  static readonly transitions = [
    'tests/acceptance/service-restart.test.ts',
    'tests/acceptance/service-retained-plan.test.ts',
  ];
  static readonly sources = [
    'tests/acceptance/npm-source.test.ts',
    'tests/acceptance/git-source.test.ts',
    'tests/acceptance/git-build.test.ts',
  ];
  static readonly runtime = [
    'tests/acceptance/service-application.test.ts',
    'tests/acceptance/service-authority.test.ts',
  ];
  static readonly kata = [
    'tests/acceptance/kata-backend.test.ts',
    'tests/acceptance/kata-qualification.test.ts',
    'tests/acceptance/kata-resources.test.ts',
    'tests/acceptance/kata-runner.test.ts',
    'tests/acceptance/kata-task-configuration.test.ts',
  ];
  static inventory(
    files = readdirSync('tests/acceptance').filter(this.testFile).map(this.path),
  ): Record<string, string[]> {
    const result: Record<string, string[]> = {
      foundation: [],
      kata: [],
      transitions: [],
      sources: [],
      runtime: [],
      'git-installed': [],
      registered: [],
      'build-registered': [],
    };
    if (new Set(files).size !== files.length || files.length === 0)
      throw new Error('INVALID_TEST_INVENTORY');
    this.distribute(files, result);
    this.required(files);
    this.nonempty(result);
    return result;
  }
  private static distribute(files: string[], result: Record<string, string[]>): void {
    for (const file of files) {
      if (!/^tests\/acceptance\/[a-z0-9-]+\.test\.ts$/.test(file))
        throw new Error('INVALID_TEST_INVENTORY');
      result[this.group(file)]!.push(file);
    }
  }
  private static group(file: string): string {
    if (file.startsWith('tests/acceptance/kata-')) return 'kata';
    if (file === 'tests/acceptance/build-registered-install.test.ts') return 'build-registered';
    if (
      [
        'tests/acceptance/registered-install.test.ts',
        'tests/acceptance/git-registered-install.test.ts',
      ].includes(file)
    )
      return 'registered';
    if (file === 'tests/acceptance/git-install.test.ts') return 'git-installed';
    if (this.transitions.includes(file)) return 'transitions';
    if (this.sources.includes(file)) return 'sources';
    if (this.runtime.includes(file) || file.endsWith('-install.test.ts')) return 'runtime';
    return 'foundation';
  }
  private static required(files: string[]): void {
    const required = [
      ...this.transitions,
      ...this.sources,
      ...this.runtime,
      ...this.kata,
      'tests/acceptance/git-install.test.ts',
      'tests/acceptance/registered-install.test.ts',
      'tests/acceptance/git-registered-install.test.ts',
      'tests/acceptance/build-registered-install.test.ts',
    ];
    for (const file of required)
      if (!files.includes(file)) throw new Error('MISSING_REQUIRED_TEST');
  }
  private static nonempty(result: Record<string, string[]>): void {
    for (const group of Object.values(result)) {
      if (group.length === 0) throw new Error('EMPTY_TEST_PARTITION');
      group.sort();
    }
  }
  private static testFile(name: string): boolean {
    return name.endsWith('.test.ts');
  }
  private static path(name: string): string {
    return 'tests/acceptance/' + name;
  }
  static run(args: string[]): number {
    try {
      const inventory = this.inventory();
      if (args.length === 1 && args[0] === 'inventory') {
        process.stdout.write(JSON.stringify(inventory) + '\n');
        return 0;
      }
      if (args.length !== 2 || args[0] !== 'smoke' || !Object.hasOwn(inventory, args[1]!)) return 2;
      const result = spawnSync(process.execPath, ['test', ...inventory[args[1]!]!], {
        stdio: 'inherit',
      });
      return result.status ?? 1;
    } catch {
      return 2;
    }
  }
}
if (import.meta.main) process.exitCode = VerificationPartitions.run(process.argv.slice(2));
