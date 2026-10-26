import{test}from'bun:test';
import{RegisteredInstallTests}from'./registered-install-fixture.js';
const suite=new RegisteredInstallTests();test('smoke: successive registered git selections retain current closures with actual source stopped',suite.program.bind(suite,'git'),480000);
