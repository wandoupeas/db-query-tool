# DB Query Tool

[简体中文](./README.zh-CN.md)

DB Query Tool is a desktop application for database querying, result export, and scheduled report delivery. It uses Electron for the desktop shell and Express for the local backend service. The application supports MySQL and PostgreSQL, exports query results to XLSX, and can send reports by email or WeCom/Enterprise WeChat robots.

## Features

- Local authentication: register and log in with local accounts.
- Per-user isolation: saved connections, SMTP settings, WeCom robots, and schedules are isolated by user.
- Database connection management: save, switch, test, and delete MySQL/PostgreSQL connections.
- SQL workspace: execute SQL, view paginated results, sort columns, inspect table lists and schemas, and reuse query history.
- XLSX export: export the current query result with a custom file name and sheet name.
- Report delivery: send query results by email, WeCom robot, or both.
- Scheduled tasks: run SQL by cron expression, send results automatically, trigger manually, edit tasks, delete tasks, and inspect execution logs.
- Desktop packaging: build Windows portable/zip artifacts and macOS dmg artifacts.

## Tech Stack

- Runtime: Node.js 16+
- Desktop: Electron
- Server: Express
- Database drivers: mysql2, pg
- Local storage: sql.js with a SQLite file
- Scheduler: node-cron
- Export: xlsx
- Notifications: nodemailer, WeCom robot webhook

## Project Structure

```text
.
├── electron/
│   └── main.js              # Electron main process; starts the local server and opens the window
├── public/
│   └── index.html           # Single-page frontend UI
├── tests/
│   ├── auth-flow.test.js    # Authentication and per-user isolation flow test
│   └── schedule-contract.test.js
├── server.js                # Express APIs, DB connections, export, sending, and schedule logic
├── start.bat                # Windows quick-start script
├── package.json
└── app.sqlite               # Default local application data file
```

## Requirements

- Node.js >= 16.0.0
- npm
- Network access from this machine to the target MySQL or PostgreSQL server.
- SMTP settings if email delivery is required.
- WeCom/Enterprise WeChat robot webhook if WeCom delivery is required.

## Installation

```bash
npm install
```

## Running

Start the desktop application:

```bash
npm start
```

Start only the local web/backend service for development:

```bash
npm run dev
```

The default server port is `3001`. If the port is already in use, the server tries the following ports automatically. You can also specify the starting port explicitly:

```bash
PORT=3005 npm run dev
```

On Windows, you can also run:

```bat
start.bat
```

## Usage

1. Register or log in with a local account.
2. Enter the database type, host, port, database name, username, and password.
3. Click "Test" to verify the connection, then click "Connect" to save and use it.
4. Write SQL in the editor and click "Run" to view results.
5. Export results as XLSX, or send them by email or WeCom.
6. Configure SMTP or WeCom robots, then create scheduled tasks to run SQL and deliver reports automatically.

## Configuration and Data

By default, application data is stored in `app.sqlite` in the project root. The file contains users, saved database connections, SMTP settings, WeCom robot settings, schedules, and related local application data.

You can override the SQLite file path with `APP_DB_PATH`:

```bash
APP_DB_PATH=/path/to/app.sqlite npm run dev
```

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Starting port for the local Express server |
| `APP_DB_PATH` | `./app.sqlite` | Local SQLite data file path |

Security notes:

- Do not commit a real `app.sqlite` that contains account data, database passwords, SMTP passwords, or WeCom webhooks.
- Run this tool only on trusted machines and protect the local data file.
- For team usage, use separate accounts instead of sharing sensitive connection settings.

## Scheduled Tasks

Scheduled tasks use standard cron expressions:

| Expression | Meaning |
| --- | --- |
| `0 9 * * *` | Run every day at 09:00 |
| `0 * * * *` | Run every hour |
| `*/30 * * * *` | Run every 30 minutes |
| `0 9 * * 1` | Run every Monday at 09:00 |
| `0 9 1 * *` | Run at 09:00 on the first day of every month |

Each schedule is bound to the selected database connection at creation or update time. It sends query results by email, WeCom, or both, depending on the configured delivery mode. Schedules can also be triggered manually and inspected through execution logs.

## Testing

The project currently does not define a unified `test` script in `package.json`. Run the Node.js built-in test runner directly:

```bash
node --test tests/schedule-contract.test.js
node --test tests/auth-flow.test.js
```

`auth-flow.test.js` starts a local server with a temporary SQLite file and verifies registration, login, and per-user configuration isolation.

## Packaging

Build artifacts for the current platform:

```bash
npm run build
```

Build Windows artifacts:

```bash
npm run build:win
```

Build macOS artifacts:

```bash
npm run build:mac
```

Build outputs are written to `dist/`. The Windows configuration includes portable and zip targets. The macOS configuration includes a dmg target.

## Troubleshooting

### The app starts but the page does not open

Make sure dependencies are installed. Also check whether port `3001` and the following ports are blocked by another process or security software. Electron waits for the local server before opening the window.

### Database connection fails

Verify the host, port, database name, username, and password. Also confirm that the database server allows access from the current machine. MySQL commonly uses port `3306`; PostgreSQL commonly uses port `5432`.

### Email delivery fails

Check the SMTP host, port, encryption mode, username, and password or authorization code. Some mail providers require an app-specific password and explicit SMTP enablement.

### WeCom delivery fails

Confirm that the robot webhook is complete and valid, and that the target WeCom group allows robot messages and file uploads. The tool uploads the XLSX file through the webhook key and then sends a notification.

## License

MIT
