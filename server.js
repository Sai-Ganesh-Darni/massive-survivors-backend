require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const RoomManager = require('./RoomManager');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const app = express();
app.use(express.static('public'));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Setup Redis
const pubClient = new Redis(REDIS_URL);
const subClient = pubClient.duplicate();
const redisClient = pubClient.duplicate(); // For general queries

// Add error handlers to prevent crashes when Redis is offline
const handleRedisError = (err) => console.error('Redis connection error:', err.message);
pubClient.on('error', handleRedisError);
subClient.on('error', handleRedisError);
redisClient.on('error', handleRedisError);

// Enable Redis adapter for horizontal scalability
io.adapter(createAdapter(pubClient, subClient));

const roomManager = new RoomManager(io, redisClient);

io.on('connection', (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  // Create a brand-new private room
  socket.on('create_room', async (data) => {
    try {
      await roomManager.handleCreateRoom(socket, data);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  // Join a specific room (data.roomId) or auto-match (no roomId)
  socket.on('join_room', async (data) => {
    try {
      await roomManager.handleJoin(socket, data);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('reconnect_session', async (data) => {
    try {
      await roomManager.handleReconnect(socket, data);
    } catch (err) {
      socket.emit('error', { message: err.message });
    }
  });

  socket.on('player_input', (data) => {
    roomManager.handlePlayerInput(socket, data);
  });

  socket.on('disconnect', () => {
    console.log(`Socket disconnected: ${socket.id}`);
    roomManager.handleDisconnect(socket);
  });
});

server.listen(PORT, () => {
  console.log(`Survivors-like Game Server running on port ${PORT}`);
});
