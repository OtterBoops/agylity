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

| Variable                          | Type      | Default                  | Description                                                                                                        |
| --------------------------------- | --------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Multi-Channel Notifications**   |           |                          |                                                                                                                    |
| `NOTIFICATION_CHANNELS`           | `string`  | `none`                   | Comma-separated active channels (`discord`, `webhook`, `console`, `none`). Multiple channels can run concurrently. |
| `NOTIFICATION_CHANNEL`            | `enum`    | `none`                   | Legacy single channel fallback (`discord`, `webhook`, `console`, `none`).                                          |
| `DISCORD_TOKEN`                   | `string`  | —                        | Discord Bot application secret token (encrypted at rest).                                                          |
| `DISCORD_CLIENT_ID`               | `string`  | —                        | Discord Application ID.                                                                                            |
| `DISCORD_GUILD_ID`                | `string`  | —                        | Target Discord Guild (Server) ID.                                                                                  |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | `string`  | —                        | Target Discord text channel ID for embeds.                                                                         |
| `NOTIFICATION_WEBHOOK_URL`        | `string`  | —                        | Webhook target URL for HTTP POST JSON notifications (encrypted at rest).                                           |
| `WEBHOOK_SECRET`                  | `string`  | —                        | Optional HMAC-SHA256 signature secret for `x-agylity-signature` (encrypted at rest).                               |
| **Quota Sentry & RPC**            |           |                          |                                                                                                                    |
| `ANTIGRAVITY_ENDPOINT_URL`        | `string`  | `http://127.0.0.1:60643` | Custom Language Server Connect-RPC URL.                                                                            |
| `ANTIGRAVITY_CSRF_TOKEN`          | `string`  | —                        | `x-codeium-csrf-token` authentication header value.                                                                |
| `ANTIGRAVITY_LS_PORT`             | `number`  | `60643`                  | Primary Language Server Connect-RPC port (secondary: 60642).                                                       |
| `QUOTA_CHECK_INTERVAL_SECONDS`    | `number`  | `900`                    | Sentry polling interval (900s = 15m). Min: 10.                                                                     |
| `QUOTA_ALERT_THRESHOLD_PERCENT`   | `number`  | `25`                     | Minimum quota headroom percentage triggering alert.                                                                |
| `QUOTA_MILESTONE_HOURS`           | `string`  | `24,12,3`                | Comma-separated deadline milestone evaluation windows.                                                             |
| `QUOTA_STATE_FILE_PATH`           | `string`  | `data/state.json`        | Persistent alert deduplication state file.                                                                         |
| `MIN_DISPATCH_HEADROOM_PERCENT`   | `number`  | `10`                     | Safety floor headroom % preventing paid overages. Set to `0` if overages do not apply.                             |
| **Optional Task Orchestrator**    |           |                          |                                                                                                                    |
| `ORCHESTRATOR_ENABLED`            | `boolean` | `false`                  | Enable/disable optional task continuation & worker orchestrator.                                                   |
| **Security & Encryption**         |           |                          |                                                                                                                    |
| `AGYLITY_SECRET_KEY`              | `string`  | —                        | 256-bit encryption key for AES-256-GCM. Defaults to secure keyfile `data/.agylity.key`.                            |
| **Repositories & Storage**        |           |                          |                                                                                                                    |
| `REPOSITORIES_JSON`               | `json`    | `[]`                     | JSON array of repository targets for dropdowns.                                                                    |
| `DATABASE_PATH`                   | `string`  | `data/agylity.db`        | SQLite database filepath for UI configuration overrides.                                                           |
| **Decoupled Web Dashboard**       |           |                          |                                                                                                                    |
| `WEB_UI_ENABLED`                  | `boolean` | `false`                  | Enable/disable decoupled native HTTP web dashboard.                                                                |
| `WEB_UI_PORT`                     | `number`  | `3000`                   | Web dashboard listening port.                                                                                      |
| `WEB_UI_HOST`                     | `string`  | `0.0.0.0`                | Web dashboard interface bind address.                                                                              |

---

## 3. Repositories Schema (`REPOSITORIES_JSON`)

Repositories can be configured via environment variable or edited visually in the Web UI:

```json
[
  {
    "id": "agylity",
    "name": "Agylity",
    "path": "/home/otter/Code/agylity",
    "defaultBranch": "main",
    "description": "Antigravity quota sentry & orchestrator"
  }
]
```
