// 파이프라인 실행 로직은 PipelineExecutor로 분해되었다(C1).
// runner.js는 하위 호환을 위한 얇은 진입점으로, 공개 API인 runPipeline을 재노출한다.
export { PipelineExecutor, runPipeline } from './pipeline-executor.js';
