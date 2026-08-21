export function resourceConfigFromProjectConfig(projectConfig = {}) {
  const resources = projectConfig.resources || {};
  return {
    agentTimeoutMs: Number(resources.agentTimeoutMs || 10 * 60 * 1000),
    validationTimeoutMs: Number(resources.validationTimeoutMs || 5 * 60 * 1000),
    maxLogBytes: Number(resources.maxLogBytes || 1024 * 1024),
    // agent가 도는 동안 살아있음을 알리는 간격. provider CLI는 비대화형 모드에서
    // 완료 전까지 아무것도 내보내지 않아, 이게 없으면 수 분간 화면이 멈춘 것처럼
    // 보인다. 0이면 끈다.
    progressIntervalMs: resources.progressIntervalMs === 0
      ? 0
      : Number(resources.progressIntervalMs || 30 * 1000)
  };
}
