import ts from 'typescript';
import { format, version } from 'prettier';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

interface Identity { file: string; symbol: string; fingerprint: string; }
interface Method extends Identity { lines: number; compressed: boolean; }
interface Exception extends Identity { reason: string; issue: number; }
interface Policy { formatVersion: 1; baselineCommit: string; violations: Identity[]; exceptions: Exception[]; }
interface Report { success: boolean; errors: string[]; violations: Method[]; }
interface Options { root: string; capture: string | null; json: boolean; }

class GitSource {
  constructor(readonly root: string) {}

  run(args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  }

  integration(): string { return this.run(['rev-parse', 'refs/remotes/origin/cordis']); }
  source(commit: string, file: string): string { return this.run(['show', commit + ':' + file]); }
  tree(commit: string): string[] { return this.run(['ls-tree', '-r', '--name-only', commit]).split('\n'); }

  files(): string[] {
    return this.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0');
  }

  ancestor(commit: string, integration: string): void {
    this.run(['merge-base', '--is-ancestor', commit, integration]);
  }

  storedPolicy(commit: string): Policy | null {
    if (!this.tree(commit).includes('.readability.json')) return null;
    return PolicyFile.parse(this.source(commit, '.readability.json'));
  }
}

class MethodSyntax {
  static body(node: ts.Node): ts.Block | undefined {
    if (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) ||
      ts.isGetAccessor(node) || ts.isSetAccessor(node)) return node.body;
    return undefined;
  }

  static className(node: ts.Node): string {
    const names: string[] = [];
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) {
        names.unshift(parent.name?.text ?? '<anonymous>');
      }
    }
    return names.join('.');
  }

  static symbol(node: ts.Node): string {
    const named = node as ts.MethodDeclaration;
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : named.name.getText();
    const kind = ts.isGetAccessor(node) ? 'get ' : ts.isSetAccessor(node) ? 'set ' : '';
    const scope = ts.getCombinedModifierFlags(named) & ts.ModifierFlags.Static ? 'static ' : '';
    return this.className(node) + '.' + scope + kind + name;
  }

  static fingerprint(node: ts.Node): string {
    return createHash('sha256').update(node.getText()).digest('hex');
  }

  static line(source: ts.SourceFile, position: number): number {
    return source.getLineAndCharacterOfPosition(position).line;
  }

  static lines(body: ts.Block, source: ts.SourceFile): number {
    const text = source.text.slice(body.getStart(source) + 1, body.end - 1);
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
    const lines = new Set<number>();
    let token = scanner.scan();
    while (token !== ts.SyntaxKind.EndOfFileToken) {
      const start = scanner.getTokenPos();
      const end = scanner.getTextPos();
      for (let index = start; index < end; index++) {
        if (!/\s/.test(text[index]!)) {
          lines.add(this.line(source, body.getStart(source) + 1 + index));
        }
      }
      token = scanner.scan();
    }
    return lines.size;
  }
}

class CompressedSyntax {
  private compressed = false;
  constructor(private readonly source: ts.SourceFile) {}

  inspect(body: ts.Block): boolean {
    this.compressed = false;
    this.visit(body);
    return this.compressed;
  }

  private visit(node: ts.Node): void {
    if (ts.isBlock(node)) this.statements(node.statements);
    if (ts.isVariableDeclarationList(node) && node.declarations.length > 1) {
      this.statements(node.declarations);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      this.compressed = true;
    }
    ts.forEachChild(node, this.visit.bind(this));
  }

  private statements(nodes: readonly ts.Node[]): void {
    for (let index = 1; index < nodes.length; index++) {
      const prior = nodes[index - 1]!;
      const next = nodes[index]!;
      if (MethodSyntax.line(this.source, prior.end - 1) ===
        MethodSyntax.line(this.source, next.getStart(this.source))) this.compressed = true;
    }
  }
}

class MethodCollector {
  readonly methods: Method[] = [];
  constructor(private readonly file: string, private readonly source: ts.SourceFile) {}

  collect(): Method[] {
    this.visit(this.source);
    return this.methods;
  }

  private visit(node: ts.Node): void {
    const body = MethodSyntax.body(node);
    if (body) this.methods.push({ file: this.file, symbol: MethodSyntax.symbol(node),
      fingerprint: MethodSyntax.fingerprint(node), lines: MethodSyntax.lines(body, this.source),
      compressed: new CompressedSyntax(this.source).inspect(body) });
    ts.forEachChild(node, this.visit.bind(this));
  }
}

class SourceMethods {
  static accepted(file: string): boolean {
    if (!/\.(?:[cm]?ts|tsx)$/.test(file)) return false;
    if (file.startsWith('.agents/')) {
      return file.startsWith('.agents/skills/release-workflow/scripts/');
    }
    return !/^(?:node_modules|dist|vendor|\.git|\.codegraph)\//.test(file);
  }

  static parse(file: string, source: string): Method[] {
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    return new MethodCollector(file, parsed).collect();
  }

  static async inspect(file: string, source: string): Promise<Method[]> {
    if (version !== '3.6.2') throw new Error('CANONICAL_FORMATTER_VERSION');
    const original = this.parse(file, source);
    const canonical = await format(source, { parser: 'typescript', filepath: file,
      printWidth: 100, tabWidth: 2, singleQuote: true, semi: true, trailingComma: 'all' });
    const formatted = this.parse(file, canonical);
    if (formatted.length !== original.length) throw new Error('CANONICAL_METHOD_MISMATCH');
    for (let index = 0; index < original.length; index++) original[index]!.lines = formatted[index]!.lines;
    return original;
  }

  static violating(method: Method): boolean { return method.lines > 20 || method.compressed; }
  static identity(method: Identity): Identity {
    return { file: method.file, symbol: method.symbol, fingerprint: method.fingerprint };
  }
  static key(method: Identity): string { return JSON.stringify(this.identity(method)); }
}

class PolicyFile {
  static parse(source: string): Policy {
    const value = JSON.parse(source) as Policy;
    if (value.formatVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.baselineCommit) ||
      !Array.isArray(value.violations) || !Array.isArray(value.exceptions)) {
      throw new Error('INVALID_READABILITY_POLICY');
    }
    return value;
  }

  static baseline(policy: Policy): string {
    return JSON.stringify({ baselineCommit: policy.baselineCommit, violations: policy.violations });
  }

  static write(root: string, policy: Policy): void {
    writeFileSync(join(root, '.readability.json'), JSON.stringify(policy, null, 2) + '\n', { flag: 'wx' });
  }
}

class Baseline {
  constructor(private readonly git: GitSource) {}

  async inventory(commit: string): Promise<Identity[]> {
    const inventory: Identity[] = [];
    for (const file of this.git.tree(commit).sort()) {
      if (!SourceMethods.accepted(file)) continue;
      const methods = await SourceMethods.inspect(file, this.git.source(commit, file));
      for (const method of methods) {
        if (SourceMethods.violating(method)) inventory.push(SourceMethods.identity(method));
      }
    }
    return inventory;
  }

  async capture(commit: string): Promise<void> {
    if (commit !== this.git.integration()) throw new Error('BASELINE_MUST_MATCH_ORIGIN_CORDIS');
    const violations = await this.inventory(commit);
    PolicyFile.write(this.git.root, { formatVersion: 1, baselineCommit: commit, violations, exceptions: [] });
  }

  async verify(policy: Policy): Promise<void> {
    const integration = this.git.integration();
    this.git.ancestor(policy.baselineCommit, integration);
    const stored = this.git.storedPolicy(integration);
    if (stored && PolicyFile.baseline(stored) !== PolicyFile.baseline(policy)) {
      throw new Error('BASELINE_PROVENANCE_CHANGED');
    }
    if (!stored && policy.baselineCommit !== integration) throw new Error('BASELINE_PROVENANCE_CHANGED');
    const expected = await this.inventory(policy.baselineCommit);
    if (JSON.stringify(expected) !== JSON.stringify(policy.violations)) throw new Error('BASELINE_MISMATCH');
  }
}

class Exceptions {
  private readonly used = new Set<Exception>();
  constructor(private readonly values: Exception[]) { this.validate(); }

  private validate(): void {
    const identities = new Set<string>();
    for (const value of this.values) {
      const key = SourceMethods.key(value);
      if (identities.has(key) || !Number.isSafeInteger(value.issue) || value.issue < 1 ||
        typeof value.reason !== 'string' || value.reason.trim().length < 20) {
        throw new Error('INVALID_READABILITY_EXCEPTION');
      }
      identities.add(key);
    }
  }

  accept(method: Method): boolean {
    for (const value of this.values) {
      if (SourceMethods.key(value) === SourceMethods.key(method)) {
        this.used.add(value);
        return true;
      }
    }
    return false;
  }

  finish(errors: string[]): void {
    for (const value of this.values) {
      if (!this.used.has(value)) errors.push('STALE_EXCEPTION: ' + value.file + ':' + value.symbol);
    }
  }
}

class WorkingSource {
  constructor(private readonly git: GitSource) {}

  async methods(): Promise<Method[]> {
    const methods: Method[] = [];
    for (const file of [...new Set(this.git.files())].sort()) {
      if (!SourceMethods.accepted(file)) continue;
      const path = join(this.git.root, file);
      if (!existsSync(path)) continue;
      if (!lstatSync(path).isFile()) throw new Error('SOURCE_SYMLINK_OR_NONFILE: ' + file);
      methods.push(...await SourceMethods.inspect(file, readFileSync(path, 'utf8')));
    }
    return methods;
  }
}

class ReadabilityCheck {
  constructor(private readonly git: GitSource) {}

  async run(): Promise<Report> {
    const policy = PolicyFile.parse(readFileSync(join(this.git.root, '.readability.json'), 'utf8'));
    await new Baseline(this.git).verify(policy);
    const grandfathered = new Set<string>();
    for (const method of policy.violations) grandfathered.add(SourceMethods.key(method));
    const exceptions = new Exceptions(policy.exceptions);
    const errors: string[] = [];
    const violations: Method[] = [];
    for (const method of await new WorkingSource(this.git).methods()) {
      if (!SourceMethods.violating(method) || grandfathered.has(SourceMethods.key(method))) continue;
      violations.push(method);
      this.errors(method, exceptions, errors);
    }
    exceptions.finish(errors);
    return { success: errors.length === 0, errors, violations };
  }

  private errors(method: Method, exceptions: Exceptions, errors: string[]): void {
    const location = method.file + ':' + method.symbol;
    if (method.lines > 20 && !exceptions.accept(method)) {
      errors.push('METHOD_LENGTH: ' + location + ' has ' + method.lines + ' body lines');
    }
    if (method.compressed) errors.push('COMPRESSED_STATEMENTS: ' + location);
  }
}

class ReadabilityArguments {
  static parse(args: string[]): Options {
    const options: Options = { root: process.cwd(), capture: null, json: false };
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (seen.has(flag)) throw new Error('INVALID_ARGUMENTS');
      seen.add(flag);
      if (flag === '--json') options.json = true;
      else if (flag === '--root' && args[index + 1]) options.root = resolve(args[++index]!);
      else if (flag === '--capture' && /^[a-f0-9]{40}$/.test(args[index + 1] ?? '')) {
        options.capture = args[++index]!;
      } else throw new Error('INVALID_ARGUMENTS');
    }
    return options;
  }
}

class ReadabilityProgram {
  static async run(): Promise<void> {
    let json = process.argv.includes('--json');
    try {
      const options = ReadabilityArguments.parse(process.argv.slice(2));
      json = options.json;
      const git = new GitSource(options.root);
      if (options.capture) return await new Baseline(git).capture(options.capture);
      this.output(await new ReadabilityCheck(git).run(), json);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'READABILITY_CHECK_FAILED';
      this.output({ success: false, errors: [message], violations: [] }, json);
    }
  }

  private static output(report: Report, json: boolean): void {
    if (json) process.stdout.write(JSON.stringify(report) + '\n');
    else if (!report.success) process.stderr.write(report.errors.join('\n') + '\n');
    if (!report.success) process.exitCode = 1;
  }
}

if (import.meta.main) await ReadabilityProgram.run();
