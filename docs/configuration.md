# Configuration Reference & Hierarchy

Agylity uses a three-tier configuration hierarchy managed by `ConfigStore` (`src/config/store.ts`).

---

## 1. Fallback Precedence Hierarchy

$$\text{Resolved Value} = \text{SQLite UI Overrides} \mathbin{??} \text{Environment Variables} \mathbin{??} \text{Built-in Defaults}$$

```
+--------------------------------------------------------------------+
| Level 1: SQLite UI Overrides (data/agylity.db)                    |
| - Persisted via Web Dashboard or API                               |
+---------------------------------+----------------------------------+
                                  | (if unset or deleted)
                                  v
+--------------------------------------------------------------------+
| Level 2: Environment Variables (.env / process.env)                |
| - Standard container injection or native Node 24 --env-file        |
+---------------------------------+----------------------------------+
                                  | (if unset or empty)
                                  v
+--------------------------------------------------------------------+
| Level 3: Built-in Defaults (BUILTIN_DEFAULTS in schema.ts)         |
| - Hardcoded, rock-solid baseline configuration                     |
+--------------------------------------------------------------------+
```

- **Instant Reversion**: Clearing an override in the Web UI deletes the database record and immediately restores the `.env` value or default without restarting the daemon.
- **Event Bus**: Subsystems subscribe to `configStore.on('change', ...)` to reload credentials, intervals, and notification channels in real-time.

---

## 2. Environment Variables Reference (`.env`)

| Variable                          | Type      | Default   | Description                                                                                                                    |
| --------------------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Multi-Channel Notifications**   |           |           |                                                                                                                                |
| `NOTIFICATION_CHANNELS`           | `string`  | `none`    | Active channels (`discord`, `webhook`, `console`, `none`). Multiple channels can run concurrently (e.g. `discord,webhook`).    |
| `DISCORD_TOKEN`                   | `string`  | —         | Discord Bot application secret token (encrypted at rest).                                                                      |
| `DISCORD_CLIENT_ID`               | `string`  | —         | Discord Application ID.                                                                                                        |
| `DISCORD_GUILD_ID`                | `string`  | —         | Target Discord Guild (Server) ID.                                                                                              |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | `string`  | —         | Target Discord text channel ID for embeds.                                                                                     |
| `WEBHOOK_URL`                     | `string`  | —         | Webhook target URL for HTTP POST JSON notifications (encrypted at rest).                                                       |
| `WEBHOOK_SECRET`                  | `string`  | —         | Optional HMAC-SHA256 signature secret for `x-agylity-signature` (encrypted at rest).                                           |
| `WEBHOOK_CUSTOM_HEADERS`          | `string`  | —         | Optional JSON object string containing custom HTTP headers sent with webhook requests (e.g. `{"Authorization":"Bearer ..."}`). |
| **Quota Sentry**                  |           |           |                                                                                                                                |
| `ANTIGRAVITY_ENDPOINT_URL`        | `string`  | —         | Custom Language Server Connect-RPC URL (port and CSRF credentials are auto-discovered from local process by default).          |
| `QUOTA_CHECK_INTERVAL_SECONDS`    | `number`  | `900`     | Sentry polling interval (900s = 15m). Min: 10.                                                                                 |
| `QUOTA_ALERT_THRESHOLD_PERCENT`   | `number`  | `25`      | Minimum quota headroom percentage triggering alert.                                                                            |
| `QUOTA_MILESTONE_HOURS`           | `string`  | `24,12,3` | Comma-separated deadline milestone evaluation windows.                                                                         |
| `MIN_DISPATCH_HEADROOM_PERCENT`   | `number`  | `10`      | Safety floor headroom % preventing paid overages. Set to `0` if overages do not apply.                                         |
| **Optional Task Orchestrator**    |           |           |                                                                                                                                |
| `ORCHESTRATOR_ENABLED`            | `boolean` | `false`   | Enable/disable optional task continuation & worker orchestrator. Sentry alerts operate when false.                             |
| **Security & Encryption**         |           |           |                                                                                                                                |
| `AGYLITY_SECRET_KEY`              | `string`  | —         | Master 256-bit key for AES-256-GCM. Accepts 64-char hex or passphrase. If unset, auto-generates key at `data/.agylity.key`.    |
| **Decoupled Web Dashboard**       |           |           |                                                                                                                                |
| `WEB_UI_ENABLED`                  | `boolean` | `false`   | Enable/disable decoupled native HTTP web dashboard.                                                                            |
| `WEB_UI_PORT`                     | `number`  | `3000`    | Web dashboard listening port.                                                                                                  |
| `WEB_UI_HOST`                     | `string`  | `0.0.0.0` | Web dashboard interface bind address.                                                                                          |

---

## 3. Repositories Management

Repository targets for task dispatch (Discord dropdown and Web UI modal) are managed directly in the Web Dashboard under **Settings → Repositories** and persisted in SQLite. This avoids storing complex, escaping-prone JSON arrays in `.env`.

When configured, each repository record includes:

- **ID**: Short unique identifier (e.g. `agylity`)
- **Name**: Display label shown in menus
- **Path**: Local workspace directory on the worker node
- **Default Branch**: Branch for continuation tasks (default: `main`)
- **Description**: Optional context displayed in dropdown options

---

## 4. Test Notification Trigger (`POST /api/notify/test`)

The web dashboard and REST API provide an endpoint to verify active notification channels without waiting for a quota milestone:

- **Endpoint**: `POST /api/notify/test`
- **Request Body**: `{}` (or optional metadata)
- **Response**: Returns channel delivery status results from the active `CompositeNotifier` (e.g. Discord, Webhook, Console).
- **Security Invariant**: Sensitive webhook URL paths, query tokens, and authorization credentials are automatically masked in the returned status message.
