# Brotato Online — Multiplayer

A browser-based, real-time multiplayer game inspired by **Brotato**. Players create or join private rooms, then survive increasingly difficult waves of enemies together. Built with Node.js + Socket.io on the backend and Phaser 3 + Vite on the frontend.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Local Setup](#local-setup)
- [How to Play](#how-to-play)
- [Room Modes](#room-modes)
- [Architecture & Diagrams](#architecture--diagrams)
- [Technical Analysis](#technical-analysis)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

---

## Features

- 🏠 **Private Rooms** — Create a room and share the code with friends
- 🔑 **Join by Code** — Paste a room UUID to join a specific match
- ⚡ **Quick Match** — Auto-matched into the next available room
- 🌊 **Wave Survival** — Progressively harder waves with 3 mob types
- 🥔 **Potato Characters** — Brotato-style potato avatars with HP/XP bars
- 🎯 **Auto-Aim & Shoot** — Projectiles auto-target the nearest mob
- 📈 **XP & Levelling** — Kill mobs to earn XP and level up stats
- 🔄 **Reconnect Support** — Session persists across dropped connections
- 🔒 **Room Isolation** — Each room is a fully independent simulation

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend runtime** | Node.js v18+ |
| **Real-time transport** | Socket.io v4 |
| **Session & snapshots** | Redis (via ioredis) |
| **Horizontal scaling** | @socket.io/redis-adapter |
| **Frontend framework** | Phaser 3 |
| **Frontend build tool** | Vite |
| **Fonts** | Google Fonts (Inter, Orbitron) |

---

## Project Structure

```
game-backend/
├── server.js          # Express + Socket.io entry point
├── RoomManager.js     # Room lifecycle, join/create/reconnect logic
├── GameLogic.js       # 60 Hz tick loop, wave state machine, physics
├── messages_contract.json  # Socket.io event reference
├── analysis.md        # Technical analysis: capacity & recovery
├── diagrams.md        # Architecture & flow diagrams (Mermaid)
├── public/            # Static HTML served by Express (legacy tester)
├── package.json
└── .env               # (not committed) environment config

game-frontend/
├── main.js            # Phaser scenes: BootScene + GameScene
├── network.js         # Socket.io client, session management
├── index.html         # Boot overlay, room panel, HUD elements
├── style.css          # Dark-mode UI, glassmorphism, animations
├── package.json
└── vite.config.js
```

---

## Prerequisites

Ensure the following are installed before proceeding:

| Tool | Version | Install |
|---|---|---|
| **Node.js** | ≥ 18.x | https://nodejs.org |
| **npm** | ≥ 9.x | Bundled with Node.js |
| **Redis** | ≥ 6.x | See below |

### Installing Redis on macOS

```bash
# Using Homebrew (recommended)
brew install redis
brew services start redis

# Verify Redis is running
redis-cli ping   # should print: PONG
```

### Installing Redis on Windows

Download and install from: https://github.com/tporadowski/redis/releases  
Or use WSL2 with `sudo apt install redis-server`.

### Installing Redis on Linux (Ubuntu/Debian)

```bash
sudo apt update && sudo apt install redis-server
sudo systemctl enable --now redis-server
redis-cli ping   # should print: PONG
```

---

## Local Setup

### 1. Clone / Download the project

```bash
# If using Git:
git clone <your-repo-url>

# Or extract the zip into a folder containing:
#   game-backend/
#   game-frontend/
```

### 2. Install Backend Dependencies

```bash
cd game-backend
npm install
```

### 3. Install Frontend Dependencies

```bash
cd game-frontend
npm install
```

### 4. Configure Environment (optional)

The backend works with defaults. To customise, create `game-backend/.env`:

```env
PORT=3000
REDIS_URL=redis://localhost:6379
```

### 5. Start Redis

```bash
# macOS (Homebrew)
brew services start redis

# Linux
sudo systemctl start redis-server

# Verify
redis-cli ping    # → PONG
```

### 6. Start the Backend

```bash
cd game-backend
npm run dev
```

You should see:
```
Survivors-like Game Server running on port 3000
```

### 7. Start the Frontend

Open a **new terminal**:

```bash
cd game-frontend
npm run dev
```

You should see:
```
VITE v5.x  ready in 123 ms
➜  Local:   http://localhost:5173/
```

### 8. Open the Game

Navigate to **http://localhost:5173** in your browser.

---

## How to Play

### Controls

| Key | Action |
|---|---|
| `W` | Move up |
| `A` | Move left |
| `S` | Move down |
| `D` | Move right |

Shooting is **fully automatic** — your character auto-aims at the nearest mob and fires when the attack timer resets.

### Objective

Survive as many waves as possible. Killing mobs earns XP. Level up to increase speed, fire rate, and damage. The game ends when all players reach 0 HP.

---

## Room Modes

### 🏠 Create Room
Creates a new private room with a unique UUID. Once in-game, your **room code** appears in the bottom-right panel. Click the copy button to share it.

### 🔑 Join by Code
Enter the full room UUID shared by another player and your username, then click **JOIN ROOM**.

### ⚡ Quick Match
Automatically places you in the first available room, or creates a new one if none exist.

---

## Testing with Multiple Players

To test multiplayer on one machine:

1. Open the game in **Window 1** (normal browser) → Create Room → copy the code
2. Open the game in **Window 2** using **Incognito / Private mode** → Join Room → paste the code

> **Why Incognito?** Both windows share `sessionStorage` only within the same tab context. Using a separate browser window (or Incognito) ensures each player has an independent session.

Alternatively, use two completely different browsers (e.g., Chrome + Firefox).

---

## Architecture & Diagrams

> 📊 **[View Architecture & Flow Diagrams →](./diagrams.md)**

Includes:
- System architecture overview (clients → server → Redis)
- Client–server Socket.io message sequence
- Wave state machine (grace → wave → game_over)
- Session & reconnection flow
- Room isolation model
- Entity coordinate system

---

## Technical Analysis

> 📋 **[View Technical Analysis →](./analysis.md)**

Covers:
- Why 50 players per room was chosen (CPU & bandwidth reasoning)
- Dual-rate game loop design (60 Hz physics / 20 Hz network)
- Wave state machine explained
- Room isolation guarantees
- Redis recovery strategy (in-memory authority + 5s snapshots)
- Disconnect vs death logic
- sessionStorage isolation to prevent multi-tab session collisions
- Full performance characteristics table

---

## Backend Architecture Assessment

> 📄 **[View Backend Architecture Assessment (PDF Submission) →](./backend_assessment.md)**

Provides a professional summary of the backend system:
- System Overview & Execution Flow (Ticker-based server, decoupled physics & network loops)
- Scalability Strategy (Horizontal scaling, Redis pub/sub messaging)
- Maximum Player Limit Rationale ($O(P \times M)$ collision CPU limits vs network constraints)
- Reliability & Recovery (Client reconnection & 5s server state restoration)
- Future Scope (Spatial Grid, Protobuf, UDP/WebRTC, Kubernetes Agones)

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the backend HTTP/WebSocket server listens on |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |

---

## Troubleshooting

### `Error: listen EADDRINUSE :::3000`

Another process is holding port 3000. Kill it:

```bash
lsof -ti :3000 | xargs kill -9
```

Then restart the backend.

---

### `Redis connection error: connect ECONNREFUSED`

Redis is not running. Start it:

```bash
# macOS
brew services start redis

# Linux
sudo systemctl start redis-server
```

The backend will still function without Redis (errors are caught and logged), but session persistence and reconnection will not work.

---

### Frontend port already in use

Vite will automatically try the next port (5174, 5175, …). Check the terminal output for the actual URL.

To force a specific port:

```bash
npm run dev -- --port 5173
```

---

### Players can see each other's sessions (same browser)

Make sure each player is using a **separate browser window** or **Incognito tab**. Session tokens are stored in `sessionStorage`, which is scoped per-tab. Two tabs in the same window share `sessionStorage`.

---

### Game shows "Connecting to server…" forever

1. Confirm the backend is running on port 3000
2. Confirm the frontend `SERVER_URL` in `network.js` matches (`http://localhost:3000`)
3. Check browser console for CORS or WebSocket errors

---

## License

MIT
