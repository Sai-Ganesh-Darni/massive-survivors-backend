# Architecture & Communication Flow

## 1. System Architecture Overview

```mermaid
graph TD
    subgraph "Clients (Browser)"
        C1[Player Tab A<br/>sessionStorage: sessionId-A]
        C2[Player Tab B<br/>sessionStorage: sessionId-B]
    end

    subgraph "Optional: Horizontal Scale"
        LB(Load Balancer / Nginx<br/>Sticky Sessions)
    end

    subgraph "Node.js Server"
        SI[Socket.io Hub]
        RM[RoomManager<br/>rooms: Map of roomId → GameLogic]
        subgraph "Room A (GameLogic)"
            GL_A[tick loop 60 Hz<br/>players · mobs · projectiles<br/>wave state machine]
        end
        subgraph "Room B (GameLogic)"
            GL_B[tick loop 60 Hz<br/>isolated state]
        end
        SI --> RM
        RM --> GL_A
        RM --> GL_B
    end

    subgraph "Redis"
        RA[(Socket.io Adapter<br/>Pub/Sub)]
        RS[(Session Store<br/>session:id → roomId)]
        RN[(Snapshot Store<br/>snapshot:roomId → state)]
    end

    C1 -->|WebSocket| SI
    C2 -->|WebSocket| SI
    SI <-->|Pub/Sub| RA
    RM -->|hset session| RS
    GL_A -->|Every 5s| RN
    GL_B -->|Every 5s| RN
```

---

## 2. Client–Server Message Flow

```mermaid
sequenceDiagram
    participant Client as Browser Client
    participant Server as Node.js Server
    participant Redis as Redis

    Note over Client, Redis: ── Fresh Join (Create Room) ──
    Client->>Server: connect (WebSocket)
    Client->>Server: create_room { username }
    Server->>Redis: hset session:{sessionId} {roomId, playerId, username}
    Server-->>Client: room_joined { roomId, sessionId, playerId, state }
    Server-->>Client: (broadcast) player_joined to others in room

    Note over Client, Redis: ── Fresh Join (Join by Code) ──
    Client->>Server: join_room { username, roomId }
    Server->>Redis: hset session:{sessionId}
    Server-->>Client: room_joined { roomId, sessionId, playerId, state }

    Note over Client, Server: ── Live Game Loop ──
    loop Physics: 60 Hz | Network: 20 Hz
        Client->>Server: player_input { seq, dx, dy }
        Server->>Server: GameLogic.update() — mobs · projectiles · collisions
        Server-->>Client: state_update { tick, phase, wave, players[], mobs[], projectiles[] }
    end

    Note over Server, Redis: ── Periodic Snapshot ──
    loop Every 5 seconds
        Server->>Redis: set snapshot:{roomId} { serialized state }
    end

    Note over Client, Redis: ── Wave Events ──
    Server-->>Client: wave_start { wave, count }
    Server-->>Client: game_over { wave, scores[] }
```

---

## 3. Wave State Machine

```mermaid
stateDiagram-v2
    [*] --> Grace : Room Created

    Grace : GRACE PERIOD\n3 seconds (180 ticks)\nPlayers move freely\nNo mobs present

    Wave : WAVE ACTIVE\n60 Hz physics tick\nMob AI steers to nearest player\nAuto-shoot fires at nearest mob\nHP / XP / Level-up processed

    GameOver : GAME OVER\nAll players hp ≤ 0\nScoreboard emitted\nRoom destroyed

    Grace --> Wave : graceTimer reaches 0\n_startWave() spawns mobs
    Wave --> Grace : All mobs eliminated\n_startGrace() clears mobs & projectiles
    Wave --> GameOver : All living players hp = 0\n_gameOver() stops tick loop
```

---

## 4. Session & Reconnection Flow

```mermaid
sequenceDiagram
    participant Browser as Browser (Tab)
    participant SS as sessionStorage (Tab-local)
    participant Server as Node.js Server
    participant Redis as Redis

    Note over Browser, Redis: ── First Connection ──
    Browser->>Server: connect()
    Browser->>Server: create_room / join_room
    Server-->>Browser: room_joined { sessionId }
    Browser->>SS: sessionStorage.setItem('brotato_session_id', sessionId)

    Note over Browser, Redis: ── Socket Drop & Auto-Reconnect (same tab) ──
    Browser-->Server: connection drops
    Browser->>Server: reconnect (socket.io built-in)
    Browser->>SS: sessionStorage.getItem('brotato_session_id') → sessionId
    Browser->>Server: reconnect_session { sessionId }
    Server->>Redis: hgetall session:{sessionId} → {roomId, playerId}
    Server->>Server: room.reconnectPlayer(playerId)
    Server-->>Browser: room_joined { restored state }

    Note over Browser, Redis: ── Different Tab (No Session Collision) ──
    Browser->>SS: sessionStorage.getItem() → null (tab-isolated)
    Browser->>Server: create_room / join_room (fresh player)
```

---

## 5. Room Isolation Model

```mermaid
graph LR
    subgraph "Room A (UUID: aec590b2...)"
        PA[Player: Alice]
        PB[Player: Bob]
        MA[Mobs: Wave 3]
        PA -.->|interact| MA
        PB -.->|interact| MA
    end

    subgraph "Room B (UUID: 7f3d1a22...)"
        PC[Player: Carol]
        MB[Mobs: Wave 1]
        PC -.->|interact| MB
    end

    RA[Socket.io Room A] -->|io.to&#40;roomIdA&#41;| PA
    RA --> PB
    RB[Socket.io Room B] -->|io.to&#40;roomIdB&#41;| PC

    note1["Room A and Room B share\nzero game state.\nEach has its own:\n• GameLogic instance\n• setInterval tick loop\n• players/mobs/projectiles Maps"]
```

---

## 6. Entity Coordinate System

```mermaid
graph TD
    subgraph "Server Coordinate Space (centred at 0,0)"
        O["Origin (0, 0)"]
        TL["Top-Left (-800, -800)"]
        TR["Top-Right (800, -800)"]
        BL["Bottom-Left (-800, 800)"]
        BR["Bottom-Right (800, 800)"]
        PS["Player spawns at ~120 units from centre"]
        MS["Mobs spawn at ~660-800 units from centre (perimeter)"]
    end

    subgraph "Phaser World Space (origin at 0,0 top-left)"
        W["World: 0 → 1600 (x), 0 → 1600 (y)"]
        TF["Transform: worldX = 800 + serverX\n          worldY = 800 + serverY"]
    end

    O --> TF
```
