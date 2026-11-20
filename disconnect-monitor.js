const { EventEmitter } = require('node:events');
const { subscribeMachineStatus, parseThreshold, statusLabel } = require('./machine-status');

class DisconnectMonitor {
  constructor(devices, { config = process.env, request = fetch, now = Date.now, log = console } = {}) {
    this.devices = new Map(devices.map(device => [device.id, {}]));
    this.config = config;
    this.request = request;
    this.now = now;
    this.log = log;
    this.running = false;
    this.stopped = false;
    this.abort = new AbortController();
  }

  receive(message) {
    if (message.type === 'connection' || message.type === 'error') {
      // Require fresh status and settings snapshots after a connection failure.
      for (const state of this.devices.values()) {
        state.live = false;
        state.setting = null;
      }
      return;
    }
    const state = this.devices.get(message.id);
    if (!state) return;
    if (message.type === 'machine_attributes' && Object.hasOwn(message.attributes, 'disconnect_threshold')) {
      state.setting = message.attributes.disconnect_threshold;
    }
    if (message.type === 'machine_status') {
      const timestamp = Number(message.ts);
      if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp > this.now()) return;
      if (state.ts != null && timestamp < state.ts) return;
      const value = String(message.value).trim().toUpperCase();
      if (!state.live || value !== state.value) state.since = timestamp;
      Object.assign(state, { value, ts: timestamp, live: true });
    }
  }

  eligible(state) {
    return !this.stopped && state.live && state.value != null
      && statusLabel(state.value) !== 'disconnected'
      && state.setting?.mode === 'enabled' && Number(state.setting.threshold) > 0
      && this.now() - state.since > Number(state.setting.threshold) * 1000
      && this.now() >= (state.retryAt ?? 0);
  }

  async api(id, suffix, options = {}) {
    const config = this.config;
    const base = config.TB_URL || (config.API_HOST ? `http://${config.API_HOST}:${config.API_PORT || 8080}` : '');
    const token = config.TB_TOKEN || config.PMSTOKEN;
    if (!base || !token) throw new Error('ThingsBoard configuration missing');
    const response = await this.request(new URL(`/api/plugins/telemetry/DEVICE/${id}/${suffix}`, base), {
      ...options,
      headers: { 'X-Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(8000)]),
    });
    if (!response.ok) throw new Error(`ThingsBoard request failed (${response.status})`);
    return response;
  }

  async disconnect(id, state) {
    try {
      // Recheck settings and current telemetry before changing a live machine.
      const settings = await (await this.api(id, 'values/attributes/SERVER_SCOPE?keys=disconnect_threshold')).json();
      state.setting = parseThreshold(settings.find(item => item.key === 'disconnect_threshold')?.value);
      if (!this.eligible(state)) return;
      const latest = await (await this.api(id, 'values/timeseries?keys=machine_status')).json();
      const sample = latest.machine_status?.[0];
      if (!sample || Number(sample.ts) < state.ts) return;
      this.receive({ type: 'machine_status', id, ts: sample.ts, value: sample.value });
      if (!this.eligible(state)) return;
      const writtenAt = this.now();
      await this.api(id, 'timeseries/ANY', {
        method: 'POST',
        body: JSON.stringify({
          ts: writtenAt,
          values: { machine_status: 100, machine_status_by_user: 100 },
        }),
      });
      // Suppress duplicate writes while waiting for the WebSocket echo.
      this.receive({ type: 'machine_status', id, ts: writtenAt, value: 100 });
      this.log.info(`Auto-disconnect: ${id} machine_status set to 100.`);
    } catch (error) {
      state.retryAt = this.now() + 30000;
      if (!this.stopped) this.log.error(`Auto-disconnect failed for ${id}: ${error.message}`);
    }
  }

  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const candidates = [...this.devices].filter(([, state]) => this.eligible(state));
      let position = 0;
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (position < candidates.length && !this.stopped) {
          const [id, state] = candidates[position++];
          if (this.eligible(state)) await this.disconnect(id, state);
        }
      }));
    } finally { this.running = false; }
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }
}

function startDisconnectMonitor(loadDevices) {
  let stopped = false;
  let monitor;
  let client;
  let timer;
  let retry;
  async function start() {
    try {
      const devices = await loadDevices();
      if (stopped) return;
      monitor = new DisconnectMonitor(devices);
      client = new EventEmitter();
      client.readyState = 1;
      client.send = raw => {
        const message = JSON.parse(raw);
        monitor.receive(message);
        if (message.type === 'error') console.error('Auto-disconnect monitor:', message.message);
      };
      client.close = () => {
        client.readyState = 3;
        client.emit('close');
        monitor.stop();
      };
      subscribeMachineStatus(client, devices);
      timer = setInterval(() => { void monitor.tick(); }, 1000);
      console.log(`Auto-disconnect monitor started for ${devices.length} machines.`);
    } catch (error) {
      console.error('Unable to start auto-disconnect monitor:', error.message);
      if (!stopped) retry = setTimeout(start, 30000);
    }
  }
  void start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(timer);
    monitor?.stop();
    client?.close();
  };
}

module.exports = { DisconnectMonitor, startDisconnectMonitor };
