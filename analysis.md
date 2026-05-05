# Technical Analysis: Architecture, Capacity & Server Recovery

## 1. Player Limit Rationale (50 Players per Room)

In a Brotato-style multiplayer game, the server must simulate a dense arena containing players, hundreds of mobs, and numerous projectiles, all at 60 physics ticks per second. The primary constraint is **CPU throughput and event-loop latency**, not raw network bandwidth.

A hard limit of **50 players per room** was chosen for the following reasons:

### A. Collision Complexity and the Event Loop

Collision detection scales as `O(P × M)` where P = players and M = mobs. With:
- 50 players, each firing a projectile every ~0.75 s
- Wave 5 spawning ~29 mobs, wave 10 ~54 mobs

Each tick must check projectile↔mob and mob↔player contacts. At 60 Hz this is roughly:

```
Tick budget = 16.6 ms
Checks/tick ≈ 50 projectiles × 54 mobs = 2,700 distance comparisons
```

This is comfortably within the tick budget on a single Node.js core. Beyond 50 players, projectile volume grows quadratically and risks tick overrun (>16.6 ms per tick), which starves the Socket.io I/O handler and causes cascading lag.

### B. Network Bandwidth

The server broadcasts a full state snapshot at **20 Hz** (every 50 ms). Each payload contains:
- Player array: `id, x, y, hp, xp, level, kills` per player
- Mob array: `id, x, y, hp, type` per mob
- Projectile array: `id, x, y` per projectile

At 50 players and 54 mobs (Wave 10), that is ~104 entities serialized to every client 20 times per second. JSON serialisation of this is roughly **4–8 KB per message**. At 50 clients this is **4–8 MB/s of outbound bandwidth per room** — manageable on a single server.

### C. Game Balance

The arena is 1600 × 1600 units. With 50 players spread across it, mobs must travel significant distances to find targets. Beyond 50 players, the arena becomes overcrowded, the mob AI degrades (mobs cluster on one player), and XP distribution becomes unbalanced.

---

## 2. Game Loop Architecture

The backend runs a **dual-rate loop**:

| Rate | Purpose |
|---|---|
| **60 Hz** (`setInterval`) | Physics: player movement, mob steering, projectile movement, collision detection, XP/level logic |
| **20 Hz** (every 3rd tick) | Network: serialize `getState()` and `emit('state_update')` to all room clients |

This decoupling is critical. If the network tick were also 60 Hz, bandwidth and CPU spent on serialization would double. Clients render at their own frame rate using the last received state.

### Wave State Machine

```
[grace 3s] ──► [wave] ──► [grace 3s] ──► [wave] ──► ... ──► [game_over]
```

- **Grace**: Players move freely. No mobs. Timer counts down 180 ticks (3 s).
- **Wave**: Mobs spawn at arena perimeter, steer to nearest *connected and alive* player. Players auto-shoot at nearest mob.
- **Game Over**: Fires when every player's `hp ≤ 0`. Emits final scoreboard. Room is removed from memory.

---

## 3. Room Isolation

Each room is a completely independent `GameLogic` instance:
- Separate `Map` for players, mobs, and projectiles
- Separate `setInterval` tick loop
- Broadcasts only to its own Socket.io room (`io.to(roomId).emit(...)`)
- Stored in `RoomManager.rooms` Map under its UUID key

Players on different rooms share no state whatsoever. A crash in one room's tick loop does not affect others.

### Room Modes

| Mode | Behaviour |
|---|---|
| **Create Room** | Always creates a fresh private UUID room. Host shares the code. |
| **Join by Code** | Joins a specific existing room by full UUID. Errors if not found / full / ended. |
| **Quick Match** | Auto-matched to the first room with available slots, or a new room if none. |

---

## 4. Server Recovery Strategy

A fully persistent 60 Hz database write is impossible — the Redis round-trip (~1 ms) alone would consume 6% of each tick budget, and serialization at 60 Hz would generate significant CPU overhead.

### Approach: In-Memory Authority with Periodic Redis Snapshots

| Layer | Role |
|---|---|
| **In-Memory** | Authoritative game state. Lives in the `GameLogic` instance on the Node.js server. Zero latency reads/writes. |
| **Redis (Snapshot Store)** | Serialized state saved every **5 seconds** under `snapshot:{roomId}`. Used for disaster recovery only. |
| **Redis (Session Store)** | Maps `sessionId → {roomId, playerId, username}`. Survives node restarts. TTL: 2 hours. |
| **Redis (Socket.io Adapter)** | Pub/Sub channel for cross-node Socket.io broadcasts. Enables horizontal scaling. |

### Recovery Flow

1. Node crashes → all its WebSocket connections drop.
2. Clients auto-reconnect (Socket.io built-in) presenting their `sessionId` from `sessionStorage`.
3. Load Balancer routes to a healthy node.
4. New node queries `session:{sessionId}` → gets `roomId`.
5. New node queries `snapshot:{roomId}` → rebuilds `GameLogic` in memory.
6. Player receives `room_joined` with restored state.
7. Maximum progress loss: **5 seconds**.

### Disconnect vs Death

A temporarily disconnected player (socket drops during a wave) is NOT treated as dead. Their `connected` flag is set to `false`:
- Mobs stop targeting them
- Game-over check uses `hp > 0` regardless of connection state
- When they reconnect, `reconnectPlayer()` sets `connected = true` and they re-enter the game

---

## 5. Session Isolation (Multi-Tab Safety)

Session tokens are stored in **`sessionStorage`** (not `localStorage`). `sessionStorage` is scoped to the browser tab — two tabs in the same browser window each have independent sessions. This prevents Tab B from accidentally stealing Tab A's session and joining the game as the wrong player.

`localStorage` was intentionally avoided because it is shared across all tabs of the same origin.

---

## 6. Performance Characteristics

| Metric | Value |
|---|---|
| Physics tick rate | 60 Hz |
| Network broadcast rate | 20 Hz |
| Max players per room | 50 |
| Wave 1 mob count | 9 |
| Wave 10 mob count | 54 |
| Snapshot interval | 5 s |
| Session TTL | 2 hours |
| Arena size | 1600 × 1600 units |
| Mob damage cooldown | 120 ticks (~2 s) |
| Player base HP | 200 |
| Auto-attack interval (Lv 1) | 45 ticks (~0.75 s) |
