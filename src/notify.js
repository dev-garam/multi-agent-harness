import { readFile } from 'node:fs/promises';
import path from 'node:path';

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function readProjectConfig(repo) {
  if (!repo) {
    return {};
  }
  return await readJson(path.join(repo, '.harness.json')) || {};
}

function channelEvents(channel) {
  return Array.isArray(channel.events) && channel.events.length > 0
    ? channel.events.map((event) => String(event))
    : ['tick.failed', 'tick.done'];
}

function channelUrl(channel) {
  if (channel.url) {
    return channel.url;
  }
  const envName = channel.urlEnv || channel.webhookUrlEnv;
  return envName ? process.env[envName] : null;
}

function channelUrlEnv(channel) {
  return channel.urlEnv || channel.webhookUrlEnv || null;
}

function notificationChannels(config = {}) {
  const notifications = config.hermes?.notifications || config.notifications || {};
  if (notifications.enabled === false) {
    return [];
  }
  return Array.isArray(notifications.channels) ? notifications.channels : [];
}

function textForEvent({ event, title, message, reportPath, payload }) {
  return [
    title || `Hermes ${event}`,
    message || null,
    payload?.repo ? `Repo: ${payload.repo}` : null,
    payload?.taskId ? `Task: ${payload.taskId}` : null,
    payload?.status ? `Status: ${payload.status}` : null,
    payload?.reason ? `Reason: ${payload.reason}` : null,
    reportPath ? `Report: ${reportPath}` : null
  ].filter(Boolean).join('\n');
}

function bodyForChannel(channel, eventPayload) {
  const text = textForEvent(eventPayload);
  if (channel.type === 'slack') {
    return { text };
  }
  if (channel.type === 'discord') {
    return { content: text };
  }
  return {
    text,
    event: eventPayload.event,
    reportPath: eventPayload.reportPath,
    payload: eventPayload.payload
  };
}

async function sendJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

export async function notifyHermesEvent({ repo, event, title, message, reportPath, payload = {} }) {
  const config = await readProjectConfig(repo);
  const channels = notificationChannels(config);
  if (channels.length === 0) {
    return {
      status: 'skipped',
      reason: 'no notification channels configured',
      channels: []
    };
  }

  const results = [];
  for (const channel of channels) {
    const name = channel.name || channel.type || 'unnamed';
    if (channel.enabled === false) {
      results.push({ name, type: channel.type, status: 'skipped', reason: 'channel disabled' });
      continue;
    }
    if (!channelEvents(channel).includes(event)) {
      results.push({ name, type: channel.type, status: 'skipped', reason: `event not subscribed: ${event}` });
      continue;
    }
    if (!['webhook', 'slack', 'discord'].includes(channel.type)) {
      results.push({ name, type: channel.type, status: 'skipped', reason: `unsupported channel type: ${channel.type}` });
      continue;
    }

    const url = channelUrl(channel);
    if (!url) {
      const envName = channelUrlEnv(channel);
      results.push({
        name,
        type: channel.type,
        status: 'skipped',
        reason: envName ? `missing env: ${envName}` : 'missing webhook url'
      });
      continue;
    }

    try {
      await sendJson(url, bodyForChannel(channel, { event, title, message, reportPath, payload }));
      results.push({ name, type: channel.type, status: 'sent' });
    } catch (error) {
      results.push({
        name,
        type: channel.type,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const sent = results.filter((result) => result.status === 'sent').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  return {
    status: sent > 0 ? (failed > 0 ? 'partial' : 'sent') : (failed > 0 ? 'failed' : 'skipped'),
    channels: results
  };
}

export function formatNotificationSummary(result) {
  if (!result) {
    return 'skipped';
  }
  if (result.reason) {
    return `${result.status} (${result.reason})`;
  }
  const summary = (result.channels || [])
    .map((channel) => `${channel.name}:${channel.status}${channel.reason ? `(${channel.reason})` : ''}`)
    .join(', ');
  return summary ? `${result.status} [${summary}]` : result.status;
}
