import path from 'node:path';
import { harnessRoot, readText } from './fs-utils.js';

export async function loadConfig() {
  const configPath = path.join(harnessRoot, 'config', 'pipelines.json');
  return JSON.parse(await readText(configPath));
}

export function getPipeline(config, name) {
  const pipelineName = name || config.defaultPipeline;
  const pipeline = config.pipelines[pipelineName];
  if (!pipeline) {
    const names = Object.keys(config.pipelines).join(', ');
    throw new Error(`Unknown pipeline "${pipelineName}". Available: ${names}`);
  }
  return { pipelineName, pipeline };
}
