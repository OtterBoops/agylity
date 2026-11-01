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

| Variable                          | Type      | Default                            | Description                                                                                                                    |
| --------------------------------- | --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Multi-Channel Notifications**   |           |                                    |                                                                                                                                |
| `NOTIFICATION_CHANNELS`           | `string`  | `none`                             | Active channels (`discord`, `webhook`, `console`, `none`). Multiple channels can run concurrently (e.g. `discord,webhook`).    |
| `DISCORD_TOKEN`                   | `string`  | —                                  | Discord Bot application secret token (encrypted at rest).                                                                      |
| `DISCORD_CLIENT_ID`               | `string`  | —                                  | Discord Application ID (auto-derived from bot token if omitted).                                                               |
| `DISCORD_GUILD_ID`                | `string`  | —                                  | Target Discord Guild (Server) ID (optional; commands register across active guilds if omitted).                                |
| `DISCORD_NOTIFICATION_CHANNEL_ID` | `string`  | —                                  | Target Discord text channel ID for embeds.                                                                                     |
| `DISCORD_OWNER_USER_ID`           | `string`  | —                                  | Authorized Discord User ID for strict single-user binding (pins first interacting user via TOFU if unset).                     |
| `DISCORD_PING_OWNER`              | `boolean` | `true`                             | Whether to mention/ping the owner (`<@ID>`) in active Discord alerts to trigger sound/push notifications.                      |
| `WEBHOOK_URL`                     | `string`  | —                                  | Webhook target URL for HTTP POST JSON notifications (encrypted at rest).                                                       |
| `WEBHOOK_SECRET`                  | `string`  | —                                  | Optional HMAC-SHA256 signature secret for `x-agylity-signature` (encrypted at rest).                                           |
| `WEBHOOK_CUSTOM_HEADERS`          | `string`  | —                                  | Optional JSON object string containing custom HTTP headers sent with webhook requests (e.g. `{"Authorization":"Bearer ..."}`). |
| **Quota Sentry**                  |           |                                    |                                                                                                                                |
| `ANTIGRAVITY_ENDPOINT_URL`        | `string`  | —                                  | Custom Language Server Connect-RPC URL (port and CSRF credentials are auto-discovered from local process by default).          |
| `ANTIGRAVITY_CSRF_TOKEN`          | `string`  | —                                  | Explicit CSRF token for Language Server Connect-RPC requests (auto-discovered if unset).                                       |
| `ANTIGRAVITY_LS_PORT`             | `number`  | `60643`                            | Explicit Connect-RPC listening port (auto-discovered if unset, default: 60643).                                                |
| `QUOTA_CHECK_INTERVAL_SECONDS`    | `number`  | `60`                               | Sentry polling interval (60s = 1m). Min: 30.                                                                                   |
| `QUOTA_ALERT_THRESHOLD_PERCENT`   | `number`  | `25`                               | Minimum quota headroom percentage triggering alert.                                                                            |
| `QUOTA_MILESTONE_HOURS`           | `string`  | `24,12,3`                          | Comma-separated deadline milestone evaluation windows.                                                                         |
| `QUOTA_STATE_FILE_PATH`           | `string`  | `data/state.json`                  | Path to the JSON state file tracking deduplicated alert firings across restarts.                                               |
| `MIN_DISPATCH_HEADROOM_PERCENT`   | `number`  | `10`                               | Safety floor headroom % preventing paid overages. Set to `0` if overages do not apply.                                         |
| **Optional Task Orchestrator**    |           |                                    |                                                                                                                                |
| `ORCHESTRATOR_ENABLED`            | `boolean` | `false`                            | Enable/disable optional task continuation & worker orchestrator. Sentry alerts operate when false.                             |
| `DEFAULT_DISPATCH_MODEL`          | `string`  | `gemini-3.8-flash`                 | Default model used for task dispatches when not explicitly selected.                                                           |
| `DEFAULT_DISPATCH_EFFORT`         | `string`  | `medium`                           | Default reasoning effort passed to `agy --effort` (`low`, `medium`, `high`, `xhigh`, `max`).                                   |
| `WORKER_SHARED_SECRET`            | `string`  | —                                  | Optional shared fallback secret token for worker runners.                                                                      |
| `QUOTA_BURN_MAX_HOURS`            | `number`  | `2`                                | Maximum hours remaining before reset to release Pre-Reset opportunistic tasks.                                                 |
| `QUOTA_BURN_MIN_HEADROOM_PERCENT` | `number`  | `30`                               | Minimum remaining pool headroom percentage required to release Pre-Reset opportunistic tasks.                                  |
| `AGY_BIN_PATH`                    | `string`  | `agy`                              | Path to official Antigravity CLI binary executable on runner hosts.                                                            |
| `REPOSITORIES_JSON`               | `string`  | `[]`                               | Optional pre-configured repositories JSON array string (alternative to Web UI configuration).                                  |
| **Security & Encryption**         |           |                                    |                                                                                                                                |
| `AGYLITY_SECRET_KEY`              | `string`  | —                                  | Master 256-bit key for AES-256-GCM. Accepts 64-char hex or passphrase. If unset, auto-generates key at `data/.agylity.key`.    |
| `DATABASE_PATH`                   | `string`  | `data/agylity.db`                  | SQLite database file path.                                                                                                     |
| **Decoupled Web Dashboard**       |           |                                    |                                                                                                                                |
| `WEB_UI_ENABLED`                  | `boolean` | `false`                            | Enable/disable decoupled native HTTP web dashboard.                                                                            |
| `WEB_UI_PORT`                     | `number`  | `8484`                             | Web dashboard listening port.                                                                                                  |
| `WEB_UI_HOST`                     | `string`  | `0.0.0.0`                          | Web dashboard interface bind address.                                                                                          |
| **Logging & Sinks**               |           |                                    |                                                                                                                                |
| `LOG_LEVEL`                       | `string`  | `info`                             | Minimum log level (`debug`, `info`, `warn`, `error`) for terminal stdout/stderr and web UI log buffer.                         |
| **Swarm Worker Runner**           |           |                                    |                                                                                                                                |
| `COORDINATOR_URL`                 | `string`  | `http://127.0.0.1:8484`            | URL of the central Agylity Coordinator server.                                                                                 |
| `RUNNER_TOKEN`                    | `string`  | —                                  | Persistent runner token (`agyr_run_...`) issued during registration.                                                           |
| `GITHUB_TOKEN`                    | `string`  | —                                  | Optional GitHub PAT used by ephemeral worker for authenticated repository cloning and branch push.                             |
| `GIT_AUTHOR_NAME`                 | `string`  | `agylity[bot]`                     | Git commit author name for automated task completion commits.                                                                  |
| `GIT_AUTHOR_EMAIL`                | `string`  | `agylity@users.noreply.github.com` | Git commit author email.                                                                                                       |

---

## 3. Discord Bot Setup & Permissions

Agylity uses Discord for real-time quota telemetry alerts, formatted progress bar embeds, and slash commands (`/quota`, `/dispatch`).

### One-Click Bot Invite Link

To authorize the bot on your Discord server with exact required permissions and slash command integration scopes, replace `<CLIENT_ID>` with your Discord Application ID from the Developer Portal's **General Information** page:

```text
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&permissions=2147601408&scope=bot%20applications.commands
```

### Discord Developer Portal Requirements

1. **OAuth2 Scopes**:
   - `bot`
   - `applications.commands` _(Mandatory for `/quota` and `/dispatch` to register on your server)_
2. **Permissions Integer (`2147601408`)**:
   - **View Channels** (`1024`)
   - **Send Messages** (`2048`)
   - **Embed Links** (`16384`) — required for quota progress bar embeds
   - **Attach Files** (`32768`)
   - **Read Message History** (`65536`)
   - **Use Slash Commands** (`2147483648`)
3. **Privileged Gateway Intents**:
   - **None required**. Leave `Message Content Intent`, `Server Members Intent`, and `Presence Intent` **disabled**. Agylity uses interaction callbacks and does not inspect general chat messages.

### Server Channel & Single-User Binding Requirements

Inside your Discord server, ensure the bot's role has permission to **View Channel**, **Send Messages**, and **Embed Links** in the channel matching `DISCORD_NOTIFICATION_CHANNEL_ID`.

To enforce the **Single-Tenant Invariant**, set `DISCORD_OWNER_USER_ID` (or **Owner Discord User ID** in the Web UI under **Settings → Notifications**) to your personal Discord User ID (Right-click your profile in Discord with Developer Mode enabled → **Copy User ID**). When set, all other Discord users are blocked from invoking `/quota` or submitting interactive modals. If left blank, Agylity automatically pins the first Discord user who interacts with the bot for the active session (Trust-On-First-Use).

---

## 4. Repositories Management

Repository targets for task dispatch (Discord dropdown and Web UI modal) are managed directly in the Web Dashboard under **Settings → Repositories** and persisted in SQLite. This avoids storing complex, escaping-prone JSON arrays in `.env`.

When configured, each repository record includes:

- **ID**: Short unique identifier (e.g. `agylity`)
- **Name**: Display label shown in menus
- **Path**: Local workspace directory on the worker node
- **Clone URL**: Optional Git clone URL (HTTPS or SSH) used by workers to clone repository on demand if the workspace directory does not exist locally
- **Default Branch**: Branch for continuation tasks (default: `main`)
- **Description**: Optional context displayed in dropdown options

---

## 5. Test Notification Trigger (`POST /api/notify/test`)

The web dashboard and REST API provide an endpoint to verify active notification channels without waiting for a quota milestone:

- **Endpoint**: `POST /api/notify/test`
- **Request Body**: `{}` (or optional metadata)
- **Response**: Returns channel delivery status results from the active `CompositeNotifier` (e.g. Discord, Webhook, Console).
- **Security Invariant**: Sensitive webhook URL paths, query tokens, and authorization credentials are automatically masked in the returned status message.
