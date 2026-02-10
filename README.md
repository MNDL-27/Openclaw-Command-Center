# OpenClaw Dashboard

A modern, real-time monitoring dashboard for OpenClaw multi-agent systems.

## Features

- **Overview** — Quick stats on agents, sessions, cron jobs
- **Agents** — View and manage registered agents
- **Sessions** — Monitor active sessions in real-time
- **Cron Jobs** — Schedule and manage automated tasks
- **n8n Workflows** — Integration with n8n automation
- **Usage** — Track API usage across providers (OpenClaw, Ollama, n8n)
- **Schedule** — Countdown timers and scheduled events

## Quick Start

```bash
# Start the dashboard server
python3 server.py

# Access at http://localhost:5555
```

## Configuration

Settings are stored in `settings.json`:
- Blog/RSS integration
- Schedule hour
- Notes path
- API keys for providers

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/proxy/openclaw/health` | Gateway health check |
| `/proxy/openclaw/sessions` | List active sessions |
| `/proxy/openclaw/cron` | List cron jobs |
| `/proxy/usage` | Usage statistics |
| `/proxy/ollama` | Ollama local/cloud status |
| `/proxy/n8n/*` | n8n API proxy |

## Tech Stack

- **Backend**: Python 3 (http.server, no dependencies)
- **Frontend**: Vanilla HTML/CSS/JS
- **Styling**: Custom dark theme with glassmorphism

## License

MIT
