# Deployment Playbooks

This guide covers deployment options for `agylity`: Docker Compose, GitOps/Portainer homelabs, and standalone systemd services.

---

## 1. Option A: Docker Compose (Recommended)

### Prerequisites

- Docker Engine >= 24.0.0
- Docker Compose v2

### Deployment Steps

1. Clone the repository and navigate into the folder:
   ```bash
   git clone https://github.com/OtterBoops/agylity.git
   cd agylity
   ```
2. Copy environment template and customize:
   ```bash
   cp .env.example .env
   nano .env
   ```
3. Start the stack in detached mode (this builds both images and starts the coordinator plus the runner):
   ```bash
   docker compose up -d
   ```
4. Authenticate the Antigravity CLI once, into the shared credentials volume:
   ```bash
   docker exec -it agylity agy
   ```
5. Follow live logs:
   ```bash
   docker compose logs -f
   ```

Access the web dashboard at `http://localhost:8484` (when `WEB_UI_ENABLED=true`).

The shipped `docker-compose.yaml` runs **both** services, so a plain `docker compose up -d` gives you a coordinator _and_ a runner. Without a runner the coordinator still polls quota and raises alerts, but every dispatched task stays `queued`.

Minimum keys in `.env` for that stack: `WEB_UI_AUTH_TOKEN` (the control plane refuses to start on a non-loopback `WEB_UI_HOST` without it), `GITHUB_TOKEN` (branch pushes and pull requests), and a runner credential — `RUNNER_TOKEN`, or a registration token if you enrol the runner through the API instead. See `docs/configuration.md` for the full surface.

---

## 2. Option B: GitOps / Portainer Homelab Integration

For homelabs managed via GitOps, Portainer, or Dockge:

1. Store secrets in your container management stack or local environment file.
2. In your compose stack, add the coordinator and — if you want unattended execution — the runner. They are **separate images**, so a coordinator-only stack cannot claim tasks:
   ```yaml
   services:
     agylity:
       image: ghcr.io/otterboops/agylity:latest
       container_name: agylity
       restart: unless-stopped
       ports:
         - '8484:8484'
       volumes:
         - agylity-data:/app/data # Or host bind mount: /opt/agylity/data:/app/data
         - agylity-gemini:/home/node/.gemini
       env_file:
         - /opt/agylity/.env

     agylity-runner:
       image: ghcr.io/otterboops/agylity-runner:latest
       container_name: agylity-runner
       restart: unless-stopped
       env_file:
         - /opt/agylity/.env
       environment:
         - COORDINATOR_URL=http://agylity:8484
         - RUNNER_STATE_PATH=/data/runner.json
         # The runner pushes branches, so the token must be named here as well as in .env —
         # `env_file` alone does not put it in the container environment.
         - GITHUB_TOKEN=${GITHUB_TOKEN}
         - GIT_AUTHOR_NAME=agylity[bot]
         - GIT_AUTHOR_EMAIL=agylity@users.noreply.github.com
         - GIT_COMMITTER_NAME=agylity[bot]
         - GIT_COMMITTER_EMAIL=agylity@users.noreply.github.com
       volumes:
         - agylity-runner-data:/data
         - agylity-gemini:/home/node/.gemini
       depends_on:
         agylity:
           condition: service_healthy

   volumes:
     agylity-data:
     agylity-gemini:
     agylity-runner-data:
   ```
3. Deploy the stack.
4. Mount `agylity-gemini` in **both** services so they share one `agy` login, then authenticate once:
   ```bash
   docker exec -it agylity agy
   ```

### 2.1. Volumes and What Lives in Them

| Volume                | Container mount      | Service             | Contents                                                                                     |
| :-------------------- | :------------------- | :------------------ | :------------------------------------------------------------------------------------------- |
| `agylity-data`        | `/app/data`          | coordinator         | SQLite database `agylity.db` and alert state `state.json`.                                   |
| `agylity-gemini`      | `/home/node/.gemini` | coordinator, runner | Antigravity CLI credentials. Shared, so a single `agy` login covers both containers.         |
| `agylity-runner-data` | `/data`              | runner              | `runner.json` (`RUNNER_STATE_PATH=/data/runner.json`): runner id, token and enrolment state. |

The runner volume is **`/data`, not `/app/data`**. `RUNNER_STATE_PATH` points at `/data/runner.json`, so a runner volume mounted at `/app/data` loses its registration state on every restart and comes back as an unregistered runner.

### 2.2. What Each Image Contains

Both images are built from the same multi-stage `Dockerfile`, use `node:26-slim` as their base, and run as the non-root `node` user.

| Property           | Coordinator (`ghcr.io/otterboops/agylity`)            | Runner (`ghcr.io/otterboops/agylity-runner`)                         |
| :----------------- | :---------------------------------------------------- | :------------------------------------------------------------------- |
| Build target       | `coordinator`                                         | `runner`                                                             |
| Command            | `node --no-warnings dist/index.js`                    | `node dist/runner-cli.js`                                            |
| Entrypoint         | `docker/entrypoint.sh` (refreshes `agy`, then exec)   | `docker/entrypoint.sh` (refreshes `agy`, then exec)                  |
| Baked binaries     | `agy`, `curl`, `procps`, CA certificates              | `agy`, `git`, `gh`, `openssh-client`, `curl`, `procps`               |
| Network posture    | `EXPOSE 8484`; outbound Connect-RPC to Antigravity    | No listening port — polls the coordinator outbound                   |
| Healthcheck        | `curl -fsS http://127.0.0.1:8484/api/health`          | None                                                                 |
| Boot-time defaults | `DATA_DIR=/app/data`, `AGY_UPDATE_ON_BOOT=background` | `RUNNER_STATE_PATH=/data/runner.json`, `AGY_UPDATE_ON_BOOT=blocking` |

The image healthcheck runs every 30s with a 5s timeout and 3 retries, over a **120s start period**. That grace window is what covers the entrypoint's `agy` refresh, which can outlast a fast application boot. The shipped compose file shortens the start period to 5s, so a coordinator still refreshing `agy` can sit at `unhealthy` for a moment — the runner's `depends_on: service_healthy` simply holds it back until the coordinator reports healthy.

`AGY_UPDATE_ON_BOOT` drives the entrypoint: `blocking` refreshes `agy` before starting the app, `background` starts the app first and refreshes alongside. Either way the refresh is fail-soft — no network does not stop the container.

### 2.3. Container Image Tags & Release Channels

Agylity container images published to GitHub Container Registry (`ghcr.io/otterboops/agylity`) enforce strict separation between formal releases and intermediate `main` branch commits:

| Tag             | Channel            | Description                                                                                                                                                                        |
| :-------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `latest`        | **Stable Release** | Points at the newest version tag that is not a pre-release — not `-beta`, `-rc` or `-alpha`. Recommended for production homelabs and compose stacks. A pre-release never moves it. |
| `1.2.3`         | **Fixed Version**  | Exact release version, published from its release tag.                                                                                                                             |
| `1.2`           | **Minor Line**     | Rolling alias for the newest patch on that minor line, so `1.2` tracks `1.2.x`. Take patch fixes without taking a minor upgrade.                                                   |
| `edge` / `main` | **Development**    | Both are published from the tip of the `main` branch on every commit. Carries intermediate changes between formal releases without touching `latest` or any version tag.           |
| `sha-<hash>`    | **Immutable**      | Commit-specific immutable tag (e.g. `sha-9d62b78`). Never repointed; use it for reproducible pins and rollbacks.                                                                   |

---

## 3. Option C: Standalone Native Node 26 Daemon

### 3.1. Build & Run

1. Ensure Node.js >= 26.0.0 is installed:
   ```bash
   node --version # >= v26.0.0
   ```
2. Install dependencies:
   ```bash
   npm ci
   npm --prefix frontend ci
   ```
3. Compile frontend client and backend TypeScript:
   ```bash
   npm run build
   ```
4. Start with native Node 26 environment file loading (`--env-file-if-exists` so a missing file is not fatal):
   ```bash
   npm start   # node --no-warnings --env-file-if-exists=.env dist/index.js
   ```

A native install runs the **coordinator only** — no runner is started. Quota polling, alerting and the dashboard work; dispatched tasks stay queued until a runner (`dist/runner-cli.js`, on a host with an authenticated `agy` CLI) points at this coordinator through `COORDINATOR_URL` and a `RUNNER_TOKEN`.

### 3.2. systemd Service Configuration (`/etc/systemd/system/agylity.service`)

Set `User`, `Group` and `WorkingDirectory` to the account and install path you actually deployed; the example uses a dedicated `agylity` account with the checkout under `/opt/agylity`.

```ini
[Unit]
Description=agylity Autonomous Quota Sentry
After=network.target

[Service]
Type=simple
User=agylity
Group=agylity
WorkingDirectory=/opt/agylity
ExecStart=/usr/bin/node --no-warnings --env-file-if-exists=.env dist/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now agylity
```

### 3.3. Standalone Runner (Native)

`dist/runner-cli.js` is the runner entrypoint, and it is a separate process from the daemon. Point it at the coordinator with either a registration token (minted from the dashboard or `POST /api/runners/registration-token`) or an already-issued runner token:

```bash
# First join: the registration token is exchanged for a runner id, which is persisted to the state file.
node dist/runner-cli.js --url http://127.0.0.1:8484 --token agyr_reg_... --name build-box --labels linux,docker --state data/runner.json

# Subsequent starts: reuse the stored identity.
node dist/runner-cli.js --url http://127.0.0.1:8484 --state data/runner.json
```

Flags also read from the environment as `COORDINATOR_URL`, `REGISTRATION_TOKEN` / `RUNNER_TOKEN`, `RUNNER_NAME`, `RUNNER_LABELS`, `RUNNER_REPOSITORIES`, `RUNNER_STATE_PATH`, `AGY_BIN_PATH` and `PR_POLICY`. The state file defaults to `data/runner.json`, so give it a durable path — losing it means re-enrolling. The host must have the `agy` CLI installed and authenticated, plus `git` and `gh` for branch pushes and pull requests.
