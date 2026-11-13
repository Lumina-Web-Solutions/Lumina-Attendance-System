# Lumina Attendance Server

Fingerprint attendance backend and dashboard. No dependencies and no `npm install`.

## Run it
1. Install Node.js 22.13 or newer (https://nodejs.org, the LTS version is fine).
2. In this folder run:  `node server.js`
3. On first start the console prints the admin username and password. Save them.
4. Open http://localhost:3000 and log in.

Forgot the password? Run `node server.js --reset-password`.

## Set up
1. **Settings**: choose your time zone, late grace period, and weekly off days.
2. **Devices**: add a device and copy its key (the ESP8266 firmware will ask for it).
3. **Employees**: add people, then select "Enroll fingerprint". The device walks the person through scanning.
4. **Today**: watch punches arrive live. **Attendance**: summaries, punch log, CSV export for Excel.

## Network
- The device needs to reach this server by IP, for example `http://192.168.1.20:3000`.
  Use this computer's LAN IP, not "localhost". Allow port 3000 through the firewall.
- Change the port with `PORT=8080 node server.js`.
- Data lives in `data/lumina.db`. Back up that file (stop the server first, or copy `lumina.db*`).
- To keep it running after reboot, use a service manager such as pm2 (`pm2 start server.js --name lumina`) or a systemd unit.
- For access over the internet, put it behind an HTTPS reverse proxy (Caddy or Nginx).
  The dashboard login is protected, but plain HTTP exposes the password.

## Device API (used by the firmware)
All device calls send JSON with header `X-Device-Key: <key>`.

| Call | Purpose |
|---|---|
| `POST /api/device/poll` `{fw}` | Heartbeat every ~3 s. Returns `now` (epoch seconds) and an optional `command` (`enroll` or `delete` with `finger_id`). |
| `POST /api/device/result` `{id,status,message}` | Report a command: `progress`, `done`, or `failed`. |
| `POST /api/device/punch` `{finger_id, ts?}` | Record a scan. Returns `{ok,name,type,time}`. `ts` (epoch) lets offline punches keep their real time. |

Punch type (IN/OUT) toggles automatically per person per day. Repeat scans within 30 seconds are ignored.

## Limits of this version
- Shifts that cross midnight are not handled yet.
- Sensor slots 1 to 127 are used for fingerprints.
