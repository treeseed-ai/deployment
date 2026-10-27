import { test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ServiceReleaseFixture } from '../support/release-fixture.js';
import { ServiceRuntimeFixture } from '../support/service-runtime-fixture.js';
import { PluginFixtureTools } from '../support/plugin-installation-fixture.js';
import { GitFixtureTools } from '../support/git-source-fixture.js';
class GitBuildTests {
    async program(mode: 'approved' | 'missing' | 'entry' | 'timeout' | 'isolation' | 'closure' = 'approved'): Promise<void> { const fixture = await new ServiceReleaseFixture().services(); try {
        await PluginFixtureTools.tools(fixture);
        PluginFixtureTools.certificates(fixture);
        await GitFixtureTools.helper(fixture);
        const identity = GitFixtureTools.repository(fixture), build = GitFixtureTools.buildRepository(fixture);
        fixture.refreshService();
        const image = ServiceRuntimeFixture.base, inspect = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
        if (inspect.status !== 0)
            GitFixtureTools.command('docker', ['image', 'pull', image]);
        const input = join(fixture.root, 'git-build.json'), executable = join(fixture.root, 'git-build-program');
        writeFileSync(input, JSON.stringify({ root: fixture.root, configuration: fixture.configuration, identity, build, image }));
        PluginFixtureTools.command(process.execPath, ['build', 'dist/tests/support/git-build-program.js', '--compile', '--target=bun-linux-x64', '--outfile', executable]);
        const path = join(fixture.root, 'docker-only');
        mkdirSync(path);
        const docker = spawnSync('which', ['docker'], { encoding: 'utf8' });
        if (docker.status !== 0)
            throw new Error('Docker prerequisite missing');
        symlinkSync(docker.stdout.trim(), join(path, 'docker'));
        const result = spawnSync(executable, [input, mode], { encoding: 'utf8', timeout: 240000, env: { PATH: path, HOME: fixture.root, DOCKER_CONFIG: process.env.DOCKER_CONFIG, BUILD_SECRET_CANARY: 'NEVER_INHERIT', NPM_TOKEN: 'NEVER_INHERIT' } });
        if (result.status !== 0)
            throw new Error(result.stderr);
        if(mode==='closure')expect(JSON.parse(result.stdout)).toEqual({fixtureOnly:true,native:true,buildClosure:true,sourceFree:true,noActivation:true});else if (mode === 'approved')
            expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, native: true, isolated: true, built: true, sourceFree: true, tamperRefused: true, noActivation: true });
        else
            expect(JSON.parse(result.stdout)).toEqual({ fixtureOnly: true, mode, refused: true, cleaned: true, noActivation: true });
    }
    finally {
        this.cleanup(fixture);
        PluginFixtureTools.writable(fixture.root);
        fixture.close();
    } }
    private cleanup(fixture: ServiceReleaseFixture): void { const ids = GitFixtureTools.command('docker', ['container', 'ls', '--all', '--quiet', '--no-trunc', '--filter', 'label=io.treeseed.cordis.build']); for (const id of ids.split('\n')) {
        if (!id)
            continue;
        const items = JSON.parse(GitFixtureTools.command('docker', ['container', 'inspect', id])) as Array<{
            Id: string;
            Config: {
                Labels: Record<string, string>;
            };
            Mounts: Array<{
                Source: string;
            }>;
        }>;
        const item = items[0];
        if (!item || item.Id !== id || !item.Config.Labels['io.treeseed.cordis.build'] || !item.Mounts.some(this.owned.bind(this, fixture.installation)))
            continue;
        GitFixtureTools.command('docker', ['container', 'rm', '--force', id]);
    } }
    private owned(installation: string, mount: {
        Source: string;
    }): boolean { return mount.Source.startsWith(installation + '/.cordis/artifacts/build-work-'); }
}
const suite = new GitBuildTests();
test("acceptance: native approved Git build uses disposable isolation and retains exact source-free artifacts", suite.program.bind(suite, 'approved'), 300000);
test("acceptance: native Git build refuses missing build policy and leaves no owned container", suite.program.bind(suite, 'missing'), 300000);
test("acceptance: native Git build refuses changed approved entry and leaves no owned container", suite.program.bind(suite, 'entry'), 300000);
test("acceptance: native Git build refuses deadline expiry and leaves no owned container", suite.program.bind(suite, 'timeout'), 300000);
test("acceptance: native Git build refuses altered container isolation and still removes its exact owned container", suite.program.bind(suite, 'isolation'), 300000);

test("acceptance: native Git source acquisition adopts approved build output and verifies source-free closure",suite.program.bind(suite,'closure'),300000);
