// Captures the raw stdout of a status command so it can be parsed.
export function captureOutput(rawStdout) {
  return String(rawStdout || '').trim();
}
