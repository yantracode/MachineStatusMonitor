const express = require('express');
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const { Pool } = require('pg');
const { WebSocketServer } = require('ws');
const { subscribeMachineStatus, loadMachineThresholds } = require('./machine-status');
const { startDisconnectMonitor } = require('./disconnect-monitor');

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  connectionTimeoutMillis: 5000,
  max: 5,
});
pool.on('error', error => console.error('Database pool error:', error.message));

const app = express();
const port = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health/db', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await pool.query('SELECT 1');
    res.json({ database: 'connected' });
  } catch (error) {
    console.error('Database connection failed:', error.message);
    res.status(503).json({ database: 'unavailable' });
  }
});

async function getCustomerDevices() {
    const tenantTitle = process.env.TENANT_TITLE || 'PMS Tenant';
    const { rows } = await pool.query(
      `SELECT d.id, d.name, c.title AS customer_name
       FROM public.device d
       JOIN public.customer c ON c.id = d.customer_id AND c.tenant_id = d.tenant_id
       JOIN public.tenant t ON t.id = c.tenant_id
       WHERE t.title = $1
       ORDER BY c.title, d.name, d.id`,
      [tenantTitle],
    );
    return rows;
}

app.get('/api/machines', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const rows = await getCustomerDevices();
    const machines = await loadMachineThresholds(rows);
    res.json({
      updatedAt: new Date().toISOString(),
      source: 'database',
      machines: machines.map(device => ({ ...device, status: 'unknown', parts: null })),
    });
  } catch (error) {
    console.error('Unable to load devices:', error.message);
    res.status(503).json({ error: 'Unable to load machines from the database.' });
  }
});

let stopDisconnectMonitor = () => {};
const server = app.listen(port, async error => {
  if (error) {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Set PORT=3001 in .env and restart.`
      : `Server failed to start: ${error.message}`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  console.log(`Machine Status Monitor: http://localhost:${port}`);
  stopDisconnectMonitor = startDisconnectMonitor(getCustomerDevices);
});

const statusSockets = new WebSocketServer({ server, path: '/ws/machine-status' });
statusSockets.on('connection', async client => {
  client.on('error', () => {});
  try {
    const devices = await getCustomerDevices();
    if (client.readyState !== 1) return;
    subscribeMachineStatus(client, devices);
  } catch {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'error', message: 'Unable to load machines for live status.' }));
      client.close(1011, 'Machine lookup failed');
    }
  }
});

async function shutdown() {
  stopDisconnectMonitor();
  for (const client of statusSockets.clients) client.terminate();
  statusSockets.close();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
