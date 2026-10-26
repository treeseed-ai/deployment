/** Stop admissions and await every listener and pristine-capacity drain. The
 * runtime's warm pool never contains assigned work or provider credentials. */
export function installSandboxBrokerShutdown(servers: ReadonlyArray<{
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections(): void;
}>, drain: () => Promise<void>) {
  let closing: Promise<void> | undefined, reported = false;
  const close = () => {
    if (!closing) {
      const listeners = servers.flatMap(server => [
        new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); }),
        Promise.resolve().then(() => server.closeIdleConnections()),
      ]);
      closing = Promise.allSettled([...listeners, Promise.resolve().then(drain)]).then(outcomes => {
        const failures = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Sandbox broker shutdown failed.');
      }).finally(() => { process.removeListener('SIGTERM', signal); process.removeListener('SIGINT', signal); });
    }
    return closing;
  };
  const signal = () => { void close().catch(() => {
    if (!reported) {
      reported = true; process.exitCode = 1;
      process.stderr.write(`${JSON.stringify({ source: 'sandbox-broker', status: 'shutdown-failed' })}\n`);
    }
  }); };
  process.on('SIGTERM', signal); process.on('SIGINT', signal);
  return close;
}
