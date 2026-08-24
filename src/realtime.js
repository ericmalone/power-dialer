'use strict';

/**
 * Thin wrapper over socket.io so the rest of the app can push updates without
 * knowing about sockets. Safe to call before init() - events are dropped.
 */

let io = null;

function init(server, sessionMiddleware) {
  const { Server } = require('socket.io');
  io = new Server(server, { cors: { origin: false } });

  // Reuse the express session so sockets are authenticated.
  io.engine.use(sessionMiddleware);

  io.on('connection', (socket) => {
    const sess = socket.request.session;
    const userId = sess && sess.userId;
    if (!userId) {
      socket.emit('unauthorized');
      socket.disconnect(true);
      return;
    }
    socket.join(`user:${userId}`);
    if (sess.role === 'admin') socket.join('admins');
    socket.emit('hello', { userId });
  });

  return io;
}

function toUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

function toAdmins(event, payload) {
  if (io) io.to('admins').emit(event, payload);
}

function broadcast(event, payload) {
  if (io) io.emit(event, payload);
}

module.exports = { init, toUser, toAdmins, broadcast, get io() { return io; } };
