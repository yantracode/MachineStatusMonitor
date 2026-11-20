const labels = { running: 'Running', idle: 'Idle', stopped: 'Stopped', alarm: 'Alarm', disconnected: 'Disconnected', unknown: 'Status unavailable' };
const refresh = document.querySelector('#refresh');
let liveSocket;
let reconnectTimer;
let currentMachines = [];

function connectMachineStatus() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws/machine-status`);
  liveSocket = socket;
  socket.onmessage = event => {
    if (socket !== liveSocket) return;
    const message = JSON.parse(event.data);
    if (message.type === 'machine_status') {
      const machine = currentMachines.find(item => item.id === message.id);
      if (!machine || Number(machine.statusTs ?? 0) > message.ts) return;
      Object.assign(machine, { status: message.status, statusTs: message.ts, statusValue: message.value });
      renderMachines(currentMachines);
      document.querySelector('#updated').textContent = `Live update ${new Date(message.ts).toLocaleTimeString()}`;
      document.querySelector('#error').hidden = true;
    } else if (message.type === 'machine_attributes') {
      const machine = currentMachines.find(item => item.id === message.id);
      if (!machine) return;
      machine.attributes = { ...machine.attributes, ...message.attributes };
      machine.attributesError = false;
      renderMachines(currentMachines);
    } else if (message.type === 'error') {
      const error = document.querySelector('#error');
      error.textContent = message.message;
      error.hidden = false;
    } else if (message.type === 'connection') {
      if (message.state === 'reconnecting') {
        currentMachines.forEach(machine => { machine.status = 'unknown'; });
        renderMachines(currentMachines);
      }
      document.querySelector('#updated').textContent = message.state === 'reconnecting'
        ? 'Live connection lost. Reconnecting…' : 'Waiting for machine telemetry…';
    }
  };
  socket.onclose = event => {
    if (socket !== liveSocket) return;
    currentMachines.forEach(machine => { machine.status = 'unknown'; });
    renderMachines(currentMachines);
    document.querySelector('#updated').textContent = 'Live status connection closed.';
    if (event.code !== 1013) reconnectTimer = setTimeout(connectMachineStatus, 5000);
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function updateStatusElapsed() {
  for (const node of document.querySelectorAll('[data-status-ts]')) {
    const timestamp = Number(node.dataset.statusTs);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      node.textContent = 'Waiting for telemetry…';
      continue;
    }
    const difference = Date.now() - timestamp;
    if (difference < 0) {
      node.textContent = 'Timestamp is ahead of current time';
      continue;
    }
    const seconds = Math.floor(difference / 1000);
    node.textContent = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
      .map(value => String(value).padStart(2, '0')).join(':');
  }
}

function formatThreshold(setting) {
  if (!setting) return 'Not configured';
  const seconds = Math.floor(setting.threshold);
  const duration = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
  return `${setting.mode === 'enabled' ? 'Enabled' : 'Disabled'} · ${duration}`;
}

function renderMachines(machineRows) {
    const summary = document.querySelector('#summary');
    const machines = document.querySelector('#machines');
    summary.replaceChildren();
    machines.replaceChildren();
    for (const [status, label] of Object.entries(labels)) {
      if (status === 'idle') continue;
      const card = element('article', `summary-card ${status}`, '');
      card.append(element('span', 'label', label), element('strong', '', String(machineRows.filter(machine => machine.status === status).length)));
      summary.append(card);
    }
    for (const machine of machineRows) {
      const status = Object.hasOwn(labels, machine.status) ? machine.status : 'unknown';
      const card = element('article', `machine-card ${status}`, '');
      const top = element('div', 'card-top', '');
      top.append(element('span', 'machine-icon', '▥'), element('span', 'badge', labels[status] ?? 'Status unavailable'));
      card.append(top, element('h3', '', machine.name));
      card.append(element('p', 'subtitle', machine.customer_name ?? ''));
      const statusTimestamp = element('div', 'threshold-row status-timestamp', '');
      const timestamp = Number(machine.statusTs);
      const formattedTimestamp = Number.isFinite(timestamp) && timestamp > 0
        ? new Date(timestamp).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        }) + ' IST' : 'Waiting for telemetry…';
      statusTimestamp.append(element('span', '', 'Status timestamp'), element('span', '', formattedTimestamp));
      card.append(statusTimestamp);
      const elapsedRow = element('div', 'threshold-row', '');
      const elapsedValue = element('span', '', '');
      elapsedValue.dataset.statusTs = String(machine.statusTs ?? '');
      elapsedRow.append(element('span', '', 'Time since status update'), elapsedValue);
      card.append(elapsedRow);
      const metric = element('div', 'metric', '');
      metric.append(element('span', '', 'Parts produced'), element('strong', '', machine.parts == null ? '—' : String(machine.parts)));
      card.append(metric);
      const thresholds = element('dl', 'thresholds', '');
      for (const [key, label] of [['idle_threshold', 'Idle threshold'], ['alarm_threshold', 'Alarm threshold'], ['disconnect_threshold', 'Disconnect threshold']]) {
        const row = element('div', 'threshold-row', '');
        const setting = machine.attributes?.[key];
        const settingClass = !machine.attributesError && setting
          ? `threshold-${setting.mode}` : '';
        row.append(element('dt', '', label), element('dd', settingClass,
          machine.attributesError ? 'Unable to load settings' : machine.attributes ? formatThreshold(setting) : 'Waiting for settings…'));
        thresholds.append(row);
      }
      card.append(thresholds);
      machines.append(card);
    }
    document.querySelector('#machine-count').textContent = `${machineRows.length} machines`;
    document.querySelector('.demo').textContent = 'Database devices';
    if (!machineRows.length) machines.append(element('p', '', 'No machines found.'));
    updateStatusElapsed();
}

async function loadMachines() {
  clearTimeout(reconnectTimer);
  const previousSocket = liveSocket;
  liveSocket = null;
  previousSocket?.close();
  refresh.disabled = true;
  refresh.textContent = 'Refreshing…';
  document.querySelector('#error').hidden = true;
  try {
    const response = await fetch('/api/machines', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load machine statuses. Please try again.');
    const data = await response.json();
    currentMachines = data.machines;
    renderMachines(currentMachines);
    document.querySelector('#updated').textContent = `Last refreshed ${new Date(data.updatedAt).toLocaleTimeString()}`;
    if (currentMachines.length) connectMachineStatus();
  } catch (error) {
    const message = document.querySelector('#error');
    message.textContent = error.message || 'Unable to load machine statuses.';
    message.hidden = false;
    document.querySelector('#updated').textContent = 'Refresh failed. Displayed data may be outdated.';
  } finally {
    refresh.disabled = false;
    refresh.textContent = 'Refresh status';
  }
}

refresh.addEventListener('click', loadMachines);
setInterval(updateStatusElapsed, 1000);
loadMachines();
