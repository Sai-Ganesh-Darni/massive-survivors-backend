const { v4: uuidv4 } = require('uuid');

// ─── Tuning Constants ──────────────────────────────────────────────────────────
const ARENA_HALF          = 800;   // 1600×1600 arena centred at (0,0)
const PLAYER_SPEED        = 4;
const PLAYER_HIT_R        = 18;
const PLAYER_MAX_HP       = 200;  // was 100 – more survivable
const MOB_HIT_R           = 16;
const MOB_DAMAGE          = 5;    // was 8 – less punishing
const MOB_DAMAGE_CD       = 120;  // was 90 – ~2s between hits per mob
const PROJ_SPEED          = 9;
const PROJ_RADIUS         = 6;
const PROJ_LIFE           = 90;
const GRACE_TICKS         = 180;
const ATTACK_INTERVAL     = 45;
const XP_PER_KILL         = 5;
const LEVEL_XP_BASE       = 10;

function waveEnemyCount(wave)  { return 4 + wave * 5; }  // was 5 + wave*8
function waveMobHp(wave)       { return 15 + wave * 8; } // was 20 + wave*10
function waveMobSpeed(wave)    { return 1.0 + wave * 0.07; } // was 1.2 + wave*0.08
function waveMobType(wave) {
  const r = Math.random();
  if (wave < 3)  return 1;
  if (wave < 6)  return r < 0.3 ? 2 : 1;
  return r < 0.25 ? 3 : r < 0.55 ? 2 : 1;
}

// ─── GameLogic ────────────────────────────────────────────────────────────────
class GameLogic {
  constructor(roomId, io, redis) {
    this.roomId  = roomId;
    this.io      = io;
    this.redis   = redis;

    this.maxPlayers = 50;
    this.tickRate   = 60;
    this.netRate    = 20;

    // Wave state machine: 'grace' | 'wave' | 'game_over'
    this.phase     = 'grace';
    this.wave      = 0;
    this.graceTimer = GRACE_TICKS;
    this.mobsKilledThisWave = 0;

    this.state = {
      tick:        0,
      players:     new Map(), // id → player
      mobs:        new Map(), // id → mob
      projectiles: new Map(), // id → projectile
    };

    this.pendingInputs   = new Map();
    this.lastSnapshotTime = Date.now();
  }

  // ─── Player lifecycle ──────────────────────────────────────────────────────
  addPlayer(playerId, username) {
    const angle = Math.random() * Math.PI * 2;
    this.state.players.set(playerId, {
      id: playerId, username,
      x: Math.cos(angle) * 120,
      y: Math.sin(angle) * 120,
      hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP,
      level: 1, xp: 0, xpToNext: LEVEL_XP_BASE,
      kills: 0,
      speed: PLAYER_SPEED,
      attackTimer: 0,
      attackInterval: ATTACK_INTERVAL,
      projDamage: 15,
      damageCooldowns: {}, // mobId → ticks remaining
      connected: true,
    });
  }

  reconnectPlayer(playerId, username) {
    if (this.state.players.has(playerId)) {
      this.state.players.get(playerId).connected = true;
    } else {
      this.addPlayer(playerId, username);
    }
  }

  disconnectPlayer(playerId) {
    if (this.state.players.has(playerId)) {
      this.state.players.get(playerId).connected = false;
    }
  }

  applyInput(playerId, input) {
    if (!this.pendingInputs.has(playerId)) this.pendingInputs.set(playerId, []);
    this.pendingInputs.get(playerId).push(input);
  }

  getPlayerCount()          { return this.state.players.size; }
  getConnectedPlayerCount() {
    return [...this.state.players.values()].filter(p => p.connected).length;
  }

  // ─── Serialise state for broadcast / snapshot ──────────────────────────────
  getState() {
    return {
      tick:       this.state.tick,
      phase:      this.phase,
      wave:       this.wave,
      graceTimer: this.phase === 'grace' ? Math.ceil(this.graceTimer / this.tickRate) : 0,
      players: [...this.state.players.values()].map(p => ({
        id: p.id, username: p.username,
        x: p.x, y: p.y,
        hp: p.hp, maxHp: p.maxHp,
        level: p.level, xp: p.xp, xpToNext: p.xpToNext,
        kills: p.kills, connected: p.connected,
      })),
      mobs: [...this.state.mobs.values()].map(m => ({
        id: m.id, x: m.x, y: m.y,
        hp: m.hp, maxHp: m.maxHp, type: m.type,
      })),
      projectiles: [...this.state.projectiles.values()].map(pr => ({
        id: pr.id, x: pr.x, y: pr.y, ownerId: pr.ownerId,
      })),
    };
  }

  restoreState(snapshot) {
    this.state.tick = snapshot.tick || 0;
    this.wave  = snapshot.wave  || 0;
    this.phase = snapshot.phase || 'grace';
    (snapshot.players || []).forEach(p =>
      this.state.players.set(p.id, { ...p, attackTimer: 0, damageCooldowns: {} }));
    (snapshot.mobs || []).forEach(m => this.state.mobs.set(m.id, m));
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────
  start() {
    this.tickInterval = setInterval(() => this.update(), 1000 / this.tickRate);
  }

  stop() { clearInterval(this.tickInterval); }

  // ─── Wave state machine ────────────────────────────────────────────────────
  _startGrace() {
    this.phase      = 'grace';
    this.graceTimer = GRACE_TICKS;
    this.state.mobs.clear();
    this.state.projectiles.clear();
  }

  _startWave() {
    this.wave++;
    this.phase = 'wave';
    this.mobsKilledThisWave = 0;
    const count = waveEnemyCount(this.wave);
    const hp    = waveMobHp(this.wave);
    const spd   = waveMobSpeed(this.wave);
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist  = ARENA_HALF * 0.82 + Math.random() * 100;
      const id    = uuidv4();
      this.state.mobs.set(id, {
        id, type: waveMobType(this.wave),
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        hp, maxHp: hp, speed: spd,
        damageCooldown: 0,
      });
    }
    this.io.to(this.roomId).emit('wave_start', { wave: this.wave, count });
  }

  // ─── Main tick ─────────────────────────────────────────────────────────────
  update() {
    this.state.tick++;

    if (this.phase === 'grace') {
      this._processInputs();
      this.graceTimer--;
      if (this.graceTimer <= 0) this._startWave();

    } else if (this.phase === 'wave') {
      this._processInputs();
      this._updateMobs();
      this._updateProjectiles();
      this._updateAttack();
      this._checkWaveEnd();
    }
    // game_over → loop stopped, no-op

    // Broadcast at netRate
    if (this.state.tick % Math.round(this.tickRate / this.netRate) === 0) {
      this.io.to(this.roomId).emit('state_update', this.getState());
    }

    // Periodic Redis snapshot
    const now = Date.now();
    if (now - this.lastSnapshotTime > 5000) {
      this.lastSnapshotTime = now;
      this.redis.set(`snapshot:${this.roomId}`, JSON.stringify(this.getState()), 'EX', 3600);
    }
  }

  // ─── Input processing ──────────────────────────────────────────────────────
  _processInputs() {
    for (const [pid, inputs] of this.pendingInputs.entries()) {
      const p = this.state.players.get(pid);
      if (!p || !p.connected || p.hp <= 0) continue;
      for (const inp of inputs) {
        p.x = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, p.x + inp.dx * p.speed));
        p.y = Math.max(-ARENA_HALF, Math.min(ARENA_HALF, p.y + inp.dy * p.speed));
      }
    }
    this.pendingInputs.clear();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  // Players who can receive damage and be targeted by mobs (connected + alive)
  _alivePlayers() {
    return [...this.state.players.values()].filter(p => p.hp > 0 && p.connected);
  }

  // Players that are NOT dead (hp > 0), regardless of connection state.
  // Used for game-over: a disconnected player still has HP and may reconnect.
  _livingPlayers() {
    return [...this.state.players.values()].filter(p => p.hp > 0);
  }

  _nearestPlayer(x, y) {
    let best = null, bestD2 = Infinity;
    for (const p of this._alivePlayers()) {
      const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    return { player: best, dist: Math.sqrt(bestD2) };
  }

  _nearestMob(x, y) {
    let best = null, bestD2 = Infinity;
    for (const m of this.state.mobs.values()) {
      const d2 = (m.x - x) ** 2 + (m.y - y) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = m; }
    }
    return { mob: best, dist: Math.sqrt(bestD2) };
  }

  // ─── Mob AI ────────────────────────────────────────────────────────────────
  _updateMobs() {
    const alive = this._alivePlayers();
    if (alive.length === 0) return;

    for (const mob of this.state.mobs.values()) {
      // Steer toward nearest player
      let nearP = null, minD2 = Infinity;
      for (const p of alive) {
        const d2 = (p.x - mob.x) ** 2 + (p.y - mob.y) ** 2;
        if (d2 < minD2) { minD2 = d2; nearP = p; }
      }
      if (!nearP) continue;
      const dist = Math.sqrt(minD2);
      if (dist > 0) {
        mob.x += ((nearP.x - mob.x) / dist) * mob.speed;
        mob.y += ((nearP.y - mob.y) / dist) * mob.speed;
      }

      // Damage cooldown tick
      if (mob.damageCooldown > 0) mob.damageCooldown--;

      // Mob-player contact damage
      if (mob.damageCooldown === 0) {
        for (const p of alive) {
          const d2 = (p.x - mob.x) ** 2 + (p.y - mob.y) ** 2;
          if (Math.sqrt(d2) < MOB_HIT_R + PLAYER_HIT_R) {
            p.hp = Math.max(0, p.hp - MOB_DAMAGE);
            mob.damageCooldown = MOB_DAMAGE_CD;
            break; // one damage hit per mob per cooldown
          }
        }
      }
    }
  }

  // ─── Projectile physics + collision ────────────────────────────────────────
  _updateProjectiles() {
    const toDelete = [];
    for (const pr of this.state.projectiles.values()) {
      pr.x += pr.vx;
      pr.y += pr.vy;
      pr.life--;

      if (pr.life <= 0 || Math.abs(pr.x) > ARENA_HALF + 50 || Math.abs(pr.y) > ARENA_HALF + 50) {
        toDelete.push(pr.id);
        continue;
      }

      // Check mob hits
      let hit = false;
      for (const mob of this.state.mobs.values()) {
        const d = Math.sqrt((mob.x - pr.x) ** 2 + (mob.y - pr.y) ** 2);
        if (d < PROJ_RADIUS + MOB_HIT_R) {
          mob.hp -= pr.damage;
          hit = true;
          if (mob.hp <= 0) {
            this.state.mobs.delete(mob.id);
            this.mobsKilledThisWave++;
            const shooter = this.state.players.get(pr.ownerId);
            if (shooter) {
              shooter.kills++;
              shooter.xp += XP_PER_KILL;
              if (shooter.xp >= shooter.xpToNext) this._levelUp(shooter);
            }
          }
          break;
        }
      }
      if (hit) toDelete.push(pr.id);
    }
    toDelete.forEach(id => this.state.projectiles.delete(id));
  }

  // ─── Auto-attack ───────────────────────────────────────────────────────────
  _updateAttack() {
    if (this.state.mobs.size === 0) return;
    for (const p of this._alivePlayers()) {
      p.attackTimer++;
      if (p.attackTimer >= p.attackInterval) {
        p.attackTimer = 0;
        this._fire(p);
      }
    }
  }

  _fire(player) {
    const { mob, dist } = this._nearestMob(player.x, player.y);
    if (!mob || dist > 750) return;
    const dx = mob.x - player.x, dy = mob.y - player.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const id = uuidv4();
    this.state.projectiles.set(id, {
      id, ownerId: player.id,
      x: player.x, y: player.y,
      vx: (dx / len) * PROJ_SPEED,
      vy: (dy / len) * PROJ_SPEED,
      damage: player.projDamage,
      life: PROJ_LIFE,
    });
  }

  // ─── Level-up ──────────────────────────────────────────────────────────────
  _levelUp(p) {
    p.level++;
    p.xp = 0;
    p.xpToNext  = Math.floor(p.xpToNext * 1.6);
    p.speed     = Math.min(p.speed + 0.3, 8);
    p.attackInterval = Math.max(18, p.attackInterval - 3);
    p.projDamage += 5;
    p.hp = Math.min(p.maxHp, p.hp + 20); // heal on level-up
  }

  // ─── Win / Loss conditions ─────────────────────────────────────────────────
  _checkWaveEnd() {
    // Game over only when every player's HP reaches 0 (disconnected ≠ dead)
    const living = this._livingPlayers();
    if (living.length === 0 && this.state.players.size > 0) {
      this._gameOver();
      return;
    }

    // All mobs cleared → grace period
    if (this.state.mobs.size === 0) {
      this._startGrace();
    }
  }

  _gameOver() {
    this.phase = 'game_over';
    this.stop();
    const scores = [...this.state.players.values()]
      .map(p => ({ playerId: p.id, username: p.username, wave: this.wave, kills: p.kills, level: p.level }))
      .sort((a, b) => b.kills - a.kills);
    this.io.to(this.roomId).emit('game_over', { wave: this.wave, scores });
  }
}

module.exports = GameLogic;
