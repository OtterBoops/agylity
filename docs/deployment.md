# Deployment Playbooks

This guide covers deployment options for `agylity`: Docker Compose, Arcane GitOps homelabs, and standalone systemd services.

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
3. Start container in detached mode:
   ```bash
   docker compose up -d
   ```
4. Follow live logs:
   ```bash
   docker compose logs -f
   ```

Access the web dashboard at `http://localhost:3000` (when `WEB_UI_ENABLED=true`).

---

## 2. Option B: GitOps / Portainer Homelab Integration

For homelabs managed via GitOps, Portainer, or Dockge:

1. Store secrets in your container management stack or local environment file.
2. In your compose stack, add the `agylity` service:
   ```yaml
   services:
     agylity:
       image: ghcr.io/otterboops/agylity:latest
       container_name: agylity
       restart: unless-stopped
       ports:
         - '3000:3000'
       volumes:
         - /opt/agylity/data:/app/data
       env_file:
         - /opt/agylity/.env
   ```
3. Deploy the stack.

### 2.1. Container Image Tags & Release Channels

Agylity container images published to GitHub Container Registry (`ghcr.io/otterboops/agylity`) enforce strict separation between formal releases and intermediate `main` branch commits:

| Tag             | Channel            | Description                                                                                                                               |
| --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `latest`        | **Stable Release** | Points strictly to the most recent stable release tag (e.g. `0.1.0`). Recommended for production homelabs and compose stacks.             |
| `<version>`     | **Fixed Version**  | Exact release version (e.g. `0.1.0`, `0.1`).                                                                                              |
| `edge` / `main` | **Development**    | Built from the tip of the `main` branch on every commit. Contains intermediate changes between formal releases without touching `latest`. |
| `sha-<hash>`    | **Immutable**      | Commit-specific immutable image digest tag (e.g. `sha-9d62b78`).                                                                          |

---

## 3. Option C: Standalone Native Node 24 Daemon

### 3.1. Build & Run

1. Ensure Node.js >= 24.0.0 is installed:
   ```bash
   node --version # >= v24.0.0
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
4. Start with native Node 24 environment file loading:
   ```bash
   node --env-file=.env dist/index.js
   ```

### 3.2. systemd Service Configuration (`/etc/systemd/system/agylity.service`)

```ini
[Unit]
Description=agylity Autonomous Quota Sentry
After=network.target

[Service]
Type=simple
User=otter
WorkingDirectory=/home/otter/Code/agylity
ExecStart=/usr/bin/node --env-file=.env dist/index.js
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
