export function normalizeReporterSummary(value) {
  if (!value || typeof value !== 'object') {
    return {
      valid: false,
      schemaErrors: ['Reporter summary must be a JSON object.'],
      rawSummary: value
    };
  }

  const allowedStatuses = new Set(['success', 'success_with_risks', 'failed', 'incomplete']);
  const status = String(value.status || '').trim();
  const schemaErrors = [];
  if (!allowedStatuses.has(status)) {
    schemaErrors.push(`Unsupported reporter summary status: ${status || '(missing)'}.`);
  }

  const changedFiles = Array.isArray(value.changedFiles)
    ? value.changedFiles.map((entry) => String(entry))
    : [];
  const validation = Array.isArray(value.validation)
    ? value.validation.map((entry) => ({
        id: String(entry?.id || ''),
        status: String(entry?.status || ''),
        exitCode: entry?.exitCode ?? null
      }))
    : [];
  const risks = Array.isArray(value.risks)
    ? value.risks.map((entry) => String(entry))
    : [];

  return {
    valid: schemaErrors.length === 0,
    schemaErrors,
    status: status || 'incomplete',
    summary: String(value.summary || '').trim(),
    changedFiles,
    validation,
    risks,
    rawSummary: value
  };
}

export function parseReporterSummary(output) {
  const fencedBlocks = [...String(output).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let index = fencedBlocks.length - 1; index >= 0; index -= 1) {
    try {
      return normalizeReporterSummary(JSON.parse(fencedBlocks[index][1]));
    } catch {
      // Keep scanning earlier blocks. The reporter may include examples before the final summary.
    }
  }

  return {
    valid: false,
    schemaErrors: ['No parseable reporter summary JSON block found.'],
    status: 'incomplete',
    summary: '',
    changedFiles: [],
    validation: [],
    risks: []
  };
}
