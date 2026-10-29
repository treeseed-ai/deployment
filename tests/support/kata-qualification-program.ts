import assert from 'node:assert/strict';
class KataQualificationProgram {
  async run(): Promise<void> {
    const fixture = await import('@treeseed-cordis/deployment/testing/kata');
    const Constructor = Reflect.get(fixture, 'PrivateKataFixture') as new () => unknown;
    assert.equal(typeof Constructor, 'function');
    assert.throws(this.construct.bind(this, Constructor), {
      message: 'KATA_QUALIFICATION_REQUIRED',
    });
    process.stdout.write('kata-public-fixture-unqualified-ok\n');
  }
  private construct(Constructor: new () => unknown): void {
    new Constructor();
  }
}
if (import.meta.main) await new KataQualificationProgram().run();
