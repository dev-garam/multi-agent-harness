export function resourceConfigFromProjectConfig(projectConfig = {}) {
  const resources = projectConfig.resources || {};
  return {
    agentTimeoutMs: Number(resources.agentTimeoutMs || 10 * 60 * 1000),
    validationTimeoutMs: Number(resources.validationTimeoutMs || 5 * 60 * 1000),
    maxLogBytes: Number(resources.maxLogBytes || 1024 * 1024)
  };
}
