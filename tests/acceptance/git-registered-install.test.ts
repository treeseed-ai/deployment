import{test}from'bun:test';
import{RegisteredInstallTests}from'./registered-install-contract.js';
const suite=new RegisteredInstallTests();test("acceptance: successive registered git selections retain current closures with actual source stopped",suite.program.bind(suite,'git'),480000);
