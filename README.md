# Machine Status Monitor

Small Express app serving a single machine-status page.

```bash
npm install
npm start
```

Open http://localhost:3000. Use `npm run dev` for automatic server restarts.
Set `PORT` to change the default port.

Database connection settings are loaded from the local `.env` file. Use
`.env.example` as a template. The `.env` file is excluded from Git.
Visit `/api/health/db` to check the PostgreSQL connection.

`GET /api/machines` loads devices assigned to customers of the tenant configured
by `TENANT_TITLE` in `.env` (default: `PMS Tenant`). Parts remain unavailable.

Set `TB_URL` (e.g. `http://your-thingsboard-host:8080`) and `TB_TOKEN` (a ThingsBoard
user JWT with access to these devices) in `.env` for live `machine_status` updates.
`API_HOST`, `API_PORT`, and `PMSTOKEN` are also accepted as fallback settings.
The server connects to ThingsBoard `/api/ws` and subscribes to each filtered
device. Browsers receive updates through `/ws/machine-status`; tokens stay on
the server. Lost connections reconnect automatically. Replace expired JWTs
in `.env` and restart the app.
Subscriptions are sent in batches of ten to stay below ThingsBoard's incoming
WebSocket message size limit.

Each card also subscribes to the `SERVER_SCOPE` attributes `idle_threshold`,
`alarm_threshold`, and `disconnect_threshold`. Values use the existing PMS
format `{ "mode": "enabled", "threshold": 300 }` with durations in seconds.
The page displays enabled/disabled and HH:MM:SS, updating as attributes change.
Initial threshold values load through REST with the machine list, using up to
six requests at a time. Failed requests show "Unable to load settings"; missing
attributes show "Not configured". Refresh retries the initial load.

Status mapping: 3 = running, 5 = alarm, 100 = disconnected, 0/1/2/4 = stopped.
Other values display as unavailable. This follows the existing report service's
OPERATE/ALARM/DISCONNECT mapping; adjust `statusLabel` for other machine codes.

## Automatic disconnect

Starting the server also starts a background monitor, independent of open pages.
It writes `machine_status: 100` to ThingsBoard when a machine stays in the same
status longer than its enabled, positive `disconnect_threshold` in seconds.
Machines already disconnected are skipped. Status changes reset the timer;
Each automatic write also saves `machine_status_by_user: 100` at the same
timestamp as a marker for future recovery. Automatic recovery is not implemented.
repeated samples of the same value keep the timer running. On startup or
reconnection, timing starts from the latest received telemetry timestamp.
The monitor rechecks the current setting and latest telemetry before writing,
pauses during connection failures, and retries failed writes after 30 seconds.
The tenant's device list is loaded at startup; restart to include newly assigned
devices. Notifications are not implemented yet.

Run `npm test` to check the rule using simulated requests; tests do not change
real device telemetry.

## Docker

Keep the database and ThingsBoard configuration in `.env`, then run:

```bash
docker compose up -d --build
docker compose logs -f
```

The app listens on port 3000 inside the container. The host port comes from
`PORT` in `.env` (defaults to 3000). For `PORT=8989`, open http://localhost:8989.
Credentials are passed at runtime; `.env` is excluded from the image.
Use network-accessible addresses for PostgreSQL and ThingsBoard; `localhost`
inside the container refers to that container.

Stop the app with `docker compose down`. Run one app instance so only one
background monitor writes automatic disconnect updates.
