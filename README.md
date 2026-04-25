# ✚ MedCommand EMS Protocol Application

A browser-based EMS protocol reference app for laptops, tablets, and mobile devices.  
Supports offline use, full-text search, clinical calculators, skill-level sections,  
bookmarks, day/night mode, and admin-controlled content management.

---

## Quick Start

### Requirements
- [Node.js](https://nodejs.org) v16 or higher
- Any modern web browser

### Installation

```bash
# 1. Unzip the package into a folder on your server
unzip medcommand.zip
cd medcommand

# 2. Install dependencies (one time only)
npm install

# 3. Start the server
npm start
```

The server starts on **port 3000** by default.  
Open `http://localhost:3000` (or `http://your-server-ip:3000`) in a browser.

---

## Configuration

### Change the port
```bash
PORT=8080 npm start
```

Or set the `PORT` environment variable permanently in your OS or process manager.

### Run on a custom domain with HTTPS
Place MedCommand behind a reverse proxy (Nginx or Apache) with an SSL certificate.  
See the full manual for step-by-step instructions.

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js/Express server + REST API |
| `index.html` | The MedCommand web application |
| `data.json` | All protocol data (auto-created on first run) |
| `package.json` | Node.js dependencies |

> **Backup `data.json` regularly** — it contains all your protocols, sets, tags, and settings.

---

## Default Admin Password

```
admin123
```

**Change this immediately** after first login via Admin Panel → Admin Password.

---

## Running as a System Service (Linux)

Create `/etc/systemd/system/medcommand.service`:

```ini
[Unit]
Description=MedCommand EMS Protocol Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/medcommand
ExecStart=/usr/bin/node server.js
Restart=on-failure
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl daemon-reload
sudo systemctl enable medcommand
sudo systemctl start medcommand
```

---

## API Reference

All write endpoints require `Authorization: Bearer <token>` from `POST /api/auth`.

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/api/state` | No | Full app state |
| POST | `/api/auth` | No | Login → returns token |
| GET | `/api/protocols` | No | List protocols |
| POST | `/api/protocols` | Yes | Create protocol |
| PUT | `/api/protocols/:id` | Yes | Update protocol |
| DELETE | `/api/protocols/:id` | Yes | Delete protocol |
| GET | `/api/sets` | No | Protocol sets |
| POST | `/api/sets` | Yes | Create set |
| DELETE | `/api/sets/:id` | Yes | Delete set |
| GET | `/api/tags` | No | Category tags |
| POST | `/api/tags` | Yes | Create tag |
| DELETE | `/api/tags/:id` | Yes | Delete tag |
| GET | `/api/levels` | No | Skill levels |
| POST | `/api/levels` | Yes | Create level |
| DELETE | `/api/levels/:id` | Yes | Delete level |
| PUT | `/api/settings` | Yes | Change password |
| POST | `/api/refresh` | No | Update lastRefresh timestamp |

---

## Standalone Mode

If the server is not running, the app can still be opened directly as a local HTML file  
(`index.html`). In standalone mode, all data is stored in the browser's `localStorage`  
and changes are **not** shared across devices.

The status badge in the top-right corner shows:
- 🟢 **Server** — connected, changes sync to all devices
- 🟡 **Local** — standalone mode, changes are local only

---

## License

For internal EMS agency use. Not for redistribution without permission.
