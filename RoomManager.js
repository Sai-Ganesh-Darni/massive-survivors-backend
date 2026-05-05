const { v4: uuidv4 } = require('uuid');
const GameLogic = require('./GameLogic');

class RoomManager {
  constructor(io, redis) {
    this.io = io;
    this.redis = redis;
    this.rooms = new Map(); // roomId -> GameLogic instance
    this.socketToSession = new Map(); // socket.id -> sessionId
    this.socketToRoom = new Map(); // socket.id -> roomId
    this.socketToPlayer = new Map(); // socket.id -> playerId
  }

  // ── Create a brand-new private room ────────────────────────────────────────
  async handleCreateRoom(socket, data) {
    const { username } = data;
    const newRoomId = uuidv4();
    this.createRoom(newRoomId);
    await this._joinRoom(socket, username, newRoomId);
  }

  // ── Join a specific room by ID, or auto-match ───────────────────────────────
  async handleJoin(socket, data) {
    const { username, roomId: requestedRoomId } = data;

    if (requestedRoomId) {
      // ── Join a specific room ──────────────────────────────────────────────
      const room = this.rooms.get(requestedRoomId);
      if (!room) {
        throw new Error(`Room not found. Check the code and try again.`);
      }
      if (room.getPlayerCount() >= room.maxPlayers) {
        throw new Error('Room is full (50 players max).');
      }
      if (room.phase === 'game_over') {
        throw new Error('That game has already ended.');
      }
      await this._joinRoom(socket, username, requestedRoomId);
    } else {
      // ── Auto-match: find available room or create one ─────────────────────
      let targetRoomId = this.findAvailableRoom();
      if (!targetRoomId) {
        targetRoomId = uuidv4();
        this.createRoom(targetRoomId);
      }
      await this._joinRoom(socket, username, targetRoomId);
    }
  }

  // ── Shared join logic ───────────────────────────────────────────────────────
  async _joinRoom(socket, username, targetRoomId) {
    const sessionId = uuidv4();
    const playerId  = uuidv4();

    // Persist session to Redis (expires in 2 hours)
    await this.redis.hset(`session:${sessionId}`, { roomId: targetRoomId, playerId, username });
    await this.redis.expire(`session:${sessionId}`, 7200);

    this.socketToSession.set(socket.id, sessionId);
    this.socketToRoom.set(socket.id, targetRoomId);
    this.socketToPlayer.set(socket.id, playerId);
    socket.join(targetRoomId);

    const room = this.rooms.get(targetRoomId);
    room.addPlayer(playerId, username);

    socket.emit('room_joined', {
      roomId: targetRoomId,
      sessionId,
      playerId,
      playerCount: room.getConnectedPlayerCount(),
      state: room.getState(),
    });

    // Notify existing players someone joined
    socket.to(targetRoomId).emit('player_joined', {
      username,
      playerId,
      playerCount: room.getConnectedPlayerCount(),
    });
  }

  // ── Reconnect ───────────────────────────────────────────────────────────────
  async handleReconnect(socket, data) {
    const { sessionId } = data;
    const sessionData = await this.redis.hgetall(`session:${sessionId}`);

    if (!sessionData || !sessionData.roomId) {
      throw new Error('Invalid or expired session');
    }

    const { roomId, playerId, username } = sessionData;

    let room = this.rooms.get(roomId);
    if (!room) {
      const snapshot = await this.redis.get(`snapshot:${roomId}`);
      if (snapshot) {
        this.createRoomFromSnapshot(roomId, JSON.parse(snapshot));
        room = this.rooms.get(roomId);
      } else {
        throw new Error('Room expired or no snapshot available');
      }
    }

    this.socketToSession.set(socket.id, sessionId);
    this.socketToRoom.set(socket.id, roomId);
    this.socketToPlayer.set(socket.id, playerId);
    socket.join(roomId);

    room.reconnectPlayer(playerId, username);

    socket.emit('room_joined', {
      roomId,
      sessionId,
      playerId,
      playerCount: room.getConnectedPlayerCount(),
      state: room.getState(),
    });
  }

  // ── Player input ────────────────────────────────────────────────────────────
  handlePlayerInput(socket, data) {
    const roomId   = this.socketToRoom.get(socket.id);
    const playerId = this.socketToPlayer.get(socket.id);
    if (!roomId || !playerId) return;
    const room = this.rooms.get(roomId);
    if (room) room.applyInput(playerId, data);
  }

  // ── Disconnect ──────────────────────────────────────────────────────────────
  handleDisconnect(socket) {
    const roomId   = this.socketToRoom.get(socket.id);
    const playerId = this.socketToPlayer.get(socket.id);

    this.socketToSession.delete(socket.id);
    this.socketToRoom.delete(socket.id);
    this.socketToPlayer.delete(socket.id);

    const room = this.rooms.get(roomId);
    if (room) {
      room.disconnectPlayer(playerId);
      if (room.getConnectedPlayerCount() === 0) {
        room.stop();
        this.rooms.delete(roomId);
      } else {
        // Notify remaining players
        this.io.to(roomId).emit('player_left', { playerId, playerCount: room.getConnectedPlayerCount() });
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  findAvailableRoom() {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.getPlayerCount() < room.maxPlayers && room.phase !== 'game_over') {
        return roomId;
      }
    }
    return null;
  }

  getRoomList() {
    const list = [];
    for (const [roomId, room] of this.rooms.entries()) {
      list.push({
        roomId,
        playerCount: room.getConnectedPlayerCount(),
        maxPlayers: room.maxPlayers,
        phase: room.phase
      });
    }
    return list;
  }

  createRoom(roomId) {
    const room = new GameLogic(roomId, this.io, this.redis);
    room.start();
    this.rooms.set(roomId, room);
  }

  createRoomFromSnapshot(roomId, snapshot) {
    const room = new GameLogic(roomId, this.io, this.redis);
    room.restoreState(snapshot);
    room.start();
    this.rooms.set(roomId, room);
  }
}

module.exports = RoomManager;
