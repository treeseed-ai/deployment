import{test}from'bun:test';
import{RegisteredInstallTests}from'./registered-install-contract.js';
const suite=new RegisteredInstallTests();test("acceptance: successive registered npm selections retain current closures with actual source stopped",suite.program.bind(suite,'npm'),480000);
