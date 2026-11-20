const { WebSocket } = require('ws');
const thresholdKeys = ['idle_threshold', 'alarm_threshold', 'disconnect_threshold'];

function parseThreshold(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const seconds = parsed.threshold;
    if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return null;
    if (!['enabled', 'disabled'].includes(parsed.mode)) return null;
    return { mode: parsed.mode, threshold: Number(seconds) };
  } catch { return null; }
}

async function loadMachineThresholds(devices, config = process.env, request = fetch) {
  const base = config.TB_URL || (config.API_HOST ? `http://${config.API_HOST}:${config.API_PORT || 8080}` : '');
  const token = config.TB_TOKEN || config.PMSTOKEN;
  let position = 0;
  const results = new Array(devices.length);
  await Promise.all(Array.from({ length: Math.min(6, devices.length) }, async () => {
    while (position < devices.length) {
      const index = position++;
      const device = devices[index];
      try {
        if (!base || !token) throw new Error('Missing ThingsBoard configuration');
        const url = new URL(`/api/plugins/telemetry/DEVICE/${device.id}/values/attributes/SERVER_SCOPE`, base);
        url.searchParams.set('keys', thresholdKeys.join(','));
        const response = await request(url, {
          headers: { 'X-Authorization': `Bearer ${token}` },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Attribute request failed');
        const values = await response.json();
        const attributes = Object.fromEntries(thresholdKeys.map(key => [key, null]));
        for (const item of values) {
          if (thresholdKeys.includes(item.key)) attributes[item.key] = parseThreshold(item.value);
        }
        results[index] = { ...device, attributes, attributesError: false };
      } catch {
        results[index] = { ...device, attributes: {}, attributesError: true };
      }
    }
  }));
  return results;
}

function statusLabel(value) {
  const code = String(value).trim().toUpperCase();
  if (['3', 'OPERATE', 'RUNNING'].includes(code)) return 'running';
  if (['100', 'DISCONNECT', 'DISCONNECTED'].includes(code)) return 'disconnected';
  if (['5', 'ALARM'].includes(code)) return 'alarm';
  if (code === 'IDLE') return 'idle';
  if (['0', '1', '2', '4', 'STOP', 'STOPPED'].includes(code)) return 'stopped';
  return 'unknown';
}

// One ThingsBoard connection per page, carrying all allowed device subscriptions.
function subscribeMachineStatus(client, devices, config = process.env) {
  const send = message => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const baseUrl = config.TB_URL || (config.API_HOST ? `http://${config.API_HOST}:${config.API_PORT || 8080}` : '');
  const token = config.TB_TOKEN || config.PMSTOKEN;
  if (!baseUrl || !token) {
    send({ type: 'error', message: 'Configure TB_URL and TB_TOKEN in .env to enable live status.' });
    client.close(1013, 'ThingsBoard is not configured');
    return;
  }
  let upstream;
  let retry;
  let heartbeat;
  let stopped = false;
  const commands = new Map(devices.map((device, index) => [index + 1, device.id]));
  const attributeCommands = new Map(devices.map((device, index) => [devices.length + index + 1, device.id]));
  function connect() {
    if (stopped) return;
    const url = new URL('/api/ws', baseUrl);
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    upstream = new WebSocket(url, { handshakeTimeout: 10000 });
    upstream.on('open', () => {
      send({ type: 'connection', state: 'subscribing' });
      upstream.send(JSON.stringify({ authCmd: { cmdId: 0, token } }));
      const subscriptions = [...[...commands].map(([cmdId, entityId]) => ({
          cmdId, type: 'TIMESERIES', entityType: 'DEVICE', entityId,
          keys: 'machine_status', scope: 'LATEST_TELEMETRY',
        })), ...[...attributeCommands].map(([cmdId, entityId]) => ({
          cmdId, type: 'ATTRIBUTES', entityType: 'DEVICE', entityId,
          keys: thresholdKeys.join(','), scope: 'SERVER_SCOPE',
        }))];
      // ThingsBoard limits the size of each incoming WebSocket message.
      for (let offset = 0; offset < subscriptions.length; offset += 10) {
        upstream.send(JSON.stringify({ cmds: subscriptions.slice(offset, offset + 10) }));
      }
      heartbeat = setInterval(() => {
        if (upstream.readyState === WebSocket.OPEN) upstream.ping();
      }, 25000);
    });
    upstream.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.errorCode) {
          send({ type: 'error', message: 'ThingsBoard rejected a subscription. Check token access and expiry.' });
          return;
        }
        const commandId = Number(message.subscriptionId ?? message.cmdId);
        const attributeDeviceId = attributeCommands.get(commandId);
        if (attributeDeviceId) {
          const attributes = {};
          for (const key of thresholdKeys) {
            const samples = message.data?.[key];
            if (!Array.isArray(samples) || !samples.length) continue;
            const latest = samples.reduce((a, b) => Number(a[0]) > Number(b[0]) ? a : b);
            attributes[key] = parseThreshold(latest[1]);
          }
          for (const key of message.deleted ?? []) {
            if (thresholdKeys.includes(key)) attributes[key] = null;
          }
          send({ type: 'machine_attributes', id: attributeDeviceId, attributes });
          return;
        }
        const id = commands.get(commandId);
        const samples = message.data?.machine_status;
        if (!id || !Array.isArray(samples) || !samples.length) return;
        const [ts, value] = samples.reduce((latest, sample) => Number(sample[0]) > Number(latest[0]) ? sample : latest);
        send({ type: 'machine_status', id, ts: Number(ts), value, status: statusLabel(value) });
      } catch {
        send({ type: 'error', message: 'Unable to read ThingsBoard status update.' });
      }
    });
    upstream.on('error', () => send({ type: 'error', message: 'ThingsBoard connection failed. Check URL and authentication.' }));
    upstream.on('close', code => {
      clearInterval(heartbeat);
      if (!stopped) {
        console.warn(`ThingsBoard WebSocket closed (${code}); retrying in 5 seconds.`);
        send({ type: 'connection', state: 'reconnecting' });
        retry = setTimeout(connect, 5000);
      }
    });
  }
  client.once('close', () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    if (upstream) upstream.terminate();
  });
  connect();
}

module.exports = { subscribeMachineStatus, statusLabel, parseThreshold, loadMachineThresholds };
