const test = require('node:test');
const assert = require('node:assert/strict');
const { DisconnectMonitor } = require('./disconnect-monitor');

function fixture({ setting = { mode: 'enabled', threshold: 10 }, latest = { ts: 1000, value: '3' }, failWrite = false } = {}) {
  let time = 12000;
  const writes = [];
  let reads = 0;
  const monitor = new DisconnectMonitor([{ id: 'machine-1' }], {
    config: { TB_URL: 'http://test', TB_TOKEN: 'test' },
    now: () => time,
    log: { info() {}, error() {} },
    request: async (url, options) => {
      if (options.method === 'POST') {
        writes.push(JSON.parse(options.body));
        return { ok: !failWrite, status: failWrite ? 503 : 200 };
      }
      reads++;
      return { ok: true, json: async () => url.pathname.endsWith('SERVER_SCOPE')
        ? [{ key: 'disconnect_threshold', value: setting }]
        : { machine_status: latest ? [latest] : [] } };
    },
  });
  monitor.receive({ type: 'machine_attributes', id: 'machine-1', attributes: { disconnect_threshold: setting } });
  monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 1000, value: '3' });
  return { monitor, writes, reads: () => reads, setTime: value => { time = value; } };
}

test('writes numeric 100 after enabled positive threshold, and skips duplicate writes', async () => {
  const { monitor, writes, reads } = fixture();
  await Promise.all([monitor.tick(), monitor.tick()]);
  await monitor.tick();
  assert.equal(reads(), 2);
  assert.deepEqual(writes, [{ ts: 12000, values: { machine_status: 100, machine_status_by_user: 100 } }]);
});

test('disabled, missing, zero and negative thresholds never cause writes', async () => {
  for (const setting of [null, { mode: 'disabled', threshold: 10 }, { mode: 'enabled', threshold: 0 }, { mode: 'enabled', threshold: -1 }]) {
    const { monitor, writes, reads } = fixture({ setting });
    await monitor.tick();
    assert.equal(writes.length, 0);
    assert.equal(reads(), 0);
  }
});

test('does not disconnect at the exact threshold; disconnects after it', async () => {
  const { monitor, writes, setTime } = fixture();
  setTime(11000); await monitor.tick(); assert.equal(writes.length, 0);
  setTime(11001); await monitor.tick(); assert.equal(writes.length, 1);
});

test('same-value updates keep the continuous timer; changes reset it', async () => {
  const same = fixture({ latest: { ts: 11000, value: '3' } });
  same.monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 11000, value: '3' });
  await same.monitor.tick(); assert.equal(same.writes.length, 1);
  const changed = fixture();
  changed.monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 11000, value: '5' });
  await changed.monitor.tick(); assert.equal(changed.writes.length, 0);
});

test('already disconnected status is skipped', async () => {
  const { monitor, writes, reads } = fixture();
  monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 2000, value: 100 });
  await monitor.tick(); assert.equal(writes.length, 0); assert.equal(reads(), 0);
});

test('fresh REST status change or already disconnected status prevents a stale write', async () => {
  for (const value of ['5', '100']) {
    const { monitor, writes } = fixture({ latest: { ts: 11999, value } });
    await monitor.tick(); assert.equal(writes.length, 0);
  }
});

test('rechecks disabled threshold and missing latest sample before writing', async () => {
  const disabled = fixture({ setting: { mode: 'disabled', threshold: 10 } });
  disabled.monitor.receive({ type: 'machine_attributes', id: 'machine-1', attributes: { disconnect_threshold: { mode: 'enabled', threshold: 10 } } });
  await disabled.monitor.tick(); assert.equal(disabled.writes.length, 0);
  const missing = fixture({ latest: null });
  await missing.monitor.tick(); assert.equal(missing.writes.length, 0);
});

test('connection failures pause writes until fresh settings and telemetry arrive', async () => {
  const { monitor, writes } = fixture();
  monitor.receive({ type: 'connection', state: 'reconnecting' });
  await monitor.tick(); assert.equal(writes.length, 0);
  monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 1000, value: '3' });
  await monitor.tick(); assert.equal(writes.length, 0);
  monitor.receive({ type: 'machine_attributes', id: 'machine-1', attributes: { disconnect_threshold: { mode: 'enabled', threshold: 10 } } });
  await monitor.tick(); assert.equal(writes.length, 1);
});

test('ignores unknown devices and older status samples', async () => {
  const { monitor, writes } = fixture();
  monitor.receive({ type: 'machine_status', id: 'other-machine', ts: 1000, value: 3 });
  monitor.receive({ type: 'machine_status', id: 'machine-1', ts: 500, value: 100 });
  await monitor.tick(); assert.equal(writes.length, 1);
  assert.equal(monitor.devices.size, 1);
});

test('failed write backs off; stopped monitor cannot write', async () => {
  const { monitor, writes, setTime } = fixture({ failWrite: true });
  await monitor.tick(); await monitor.tick(); assert.equal(writes.length, 1);
  setTime(42001); await monitor.tick(); assert.equal(writes.length, 2);
  monitor.stop(); setTime(90000); await monitor.tick(); assert.equal(writes.length, 2);
});
