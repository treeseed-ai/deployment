/** Structured metadata only: never forward raw container messages, SQL, or values. */
export function developmentDiagnosticEvents(output: string) {
  return output.split('\n').slice(-200).flatMap(line => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!['operation.internal-error', 'operation.failed', 'operation.output-contract-invalid'].includes(String(value.event))) return [];
      const result: Record<string, string | number> = { event: String(value.event) };
      for (const key of ['operationId', 'requestId', 'name', 'code', 'constraint']) {
        const field = value[key];
        if (typeof field === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(field)) result[key] = field;
      }
      if (typeof value.status === 'number' && value.status >= 400 && value.status <= 599) result.status = value.status;
      return [result];
    } catch { return []; }
  });
}
