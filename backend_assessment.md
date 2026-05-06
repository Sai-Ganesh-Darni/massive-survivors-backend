# Backend Architecture Assessment

This document serves as the professional architectural summary for the game backend assessment.

## 1. System Overview & Execution Flow
The backend is driven by a ticker-based, authoritative Node.js server to ensure fairness and prevent client-side manipulation. 
* **Connection & Routing:** A player connects via Socket.io. A Load Balancer routes the WebSocket upgrade to an available Node.js worker.
* **Room Instantiation:** The player emits a `create_room` or `join_room` request. The `RoomManager` initializes a private, isolated `GameLogic` instance if creating a new room, generating a unique UUID.
* **Game Loop (Physics & Network decoupling):** 
  * **Physics Loop (60 Hz):** The server processes player inputs, updates mob AI/steering, recalculates projectile trajectories, and resolves collisions using a robust $O(P \times M)$ evaluation, efficiently handling the physics budget.
  * **Network Loop (20 Hz):** To conserve bandwidth, the server broadcasts state snapshots (positions, health, XP) to all clients in the room every 50ms.
* **State Synchronization:** Clients render at their own display refresh rates using the authoritative 20 Hz server snapshots.

## 2. Scalability Strategy
To support massive groups of players and highly concurrent matches, the architecture relies on horizontal scaling and isolated game instances:
* **Horizontal Scaling:** A Load Balancer distributes incoming traffic across multiple Node.js worker nodes. 
* **Pub/Sub Messaging:** The `@socket.io/redis-adapter` enables cross-node communication. If a room spans multiple nodes, Redis Pub/Sub ensures Socket.io messages are delivered to the correct room.
* **Dynamic Room Allocation:** Each battle instance is a self-contained, event-loop isolated `GameLogic` object. Node.js processes spin up room instances dynamically in memory. As rooms end, they are garbage-collected, preventing memory leaks.
* **Stateless Scaling:** Nodes remain largely stateless beyond the active memory of rooms. Global state, matchmaking logic, and session definitions are offloaded entirely to Redis.

## 3. Maximum Player Limit Rationale
A hard limit of **50 players per room** ensures robust event-loop performance without starving network I/O.
* **CPU Constraints & Collision Detection:** In a densely populated arena with 50 players and 100+ mobs, collision detection scales at $O(P \times M)$ (Players × Mobs). At 60 Hz, the server comfortably handles the ~2,700 distance comparisons per tick required for 50 players. Exceeding this risks tick overrun (>16.6 ms per tick), which starves the Socket.io I/O handler.
* **Network Bandwidth:** Emitting a JSON state snapshot for 50 players + mobs at 20 Hz consumes roughly 4-8 MB/s per room instance. Exceeding 50 players results in quadratic bandwidth growth (more players = more projectiles + more clients to broadcast to), risking network congestion and increased latency spikes.
* **Game Balance:** The 1600×1600 arena becomes overcrowded beyond 50 players, causing mob AI to cluster excessively on certain players and disrupting XP distribution.

## 4. Reliability & Recovery
The system incorporates robust mechanisms to gracefully handle unpredictable network drops and server crashes:
* **Client Reconnection:** When a player first joins, a unique session token is generated and stored in their browser's `sessionStorage` (preventing multi-tab collision). This token is mapped in Redis (`session:{id} -> roomId`). If a player's connection drops, they remain "alive" in the game but flagged as disconnected. Upon restoring connection, they present their session token and resume gameplay instantly without losing XP or position.
* **Server Recovery:** The server writes lightweight, serialized state snapshots of the active room to Redis every 5 seconds. If a Node.js worker hard-crashes, clients auto-reconnect to a healthy node via the Load Balancer. The healthy node fetches the latest 5-second snapshot from Redis, rebuilds the `GameLogic` instance in memory, and seamlessly resumes the match.

## 5. Future Scope
For a commercial production environment, the following enterprise features would be implemented:
* **Spatial Grid Partitioning:** Upgrading the current $O(P \times M)$ collision detection to a Spatial Hash Grid or QuadTree to significantly increase the maximum player limit per room.
* **Binary Protocol Migration:** Replacing JSON over WebSockets with Protobuf or FlatBuffers to drastically reduce packet size, saving egress costs and improving mobile network stability.
* **UDP / WebRTC Integration:** Implementing WebRTC data channels for unreliable, low-latency UDP transmission of volatile data (movement), eliminating TCP head-of-line blocking.
* **Kubernetes & Agones Orchestration:** Migrating from standard Node.js workers to a dedicated game server orchestration platform like Google Agones to manage scaling, health-checking, and zero-downtime rollouts of stateful game servers.
* **Database Archiving Pipeline:** Periodically flushing high-throughput analytical data from Redis into a persistent database (e.g., MySQL or ClickHouse) for deep game-balance telemetry.
