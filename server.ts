import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";

type WaitingUser = { id: string; name: string };
type RoomPoll = {
  id: string;
  question: string;
  options: string[];
  votes: Record<string, number>;
  active: boolean;
  createdAt: string;
};

type UserState = { isMuted: boolean; isVideoOff: boolean };

const PORT = Number(process.env.PORT ?? 3000);
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE ?? 16);
const MAX_WAITING_ROOM_SIZE = Number(process.env.MAX_WAITING_ROOM_SIZE ?? 100);
const MAX_MESSAGE_LENGTH = Number(process.env.MAX_MESSAGE_LENGTH ?? 500);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? process.env.APP_URL ?? "*";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
});

const rooms: Record<string, string[]> = {};
const hosts: Record<string, string> = {};
const waitingRooms: Record<string, WaitingUser[]> = {};
const polls: Record<string, RoomPoll[]> = {};
const userNames: Record<string, string> = {};
const userStates: Record<string, UserState> = {};
const socketRooms: Record<string, string> = {};

const messageRateLimit = new Map<string, number[]>();

function sanitizeText(value: unknown, fallback = "", maxLength = 80): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isValidRoomId(roomId: string): boolean {
  return /^[a-zA-Z0-9_-]{3,64}$/.test(roomId);
}

function canSendMessage(socketId: string): boolean {
  const now = Date.now();
  const cutoff = now - 10_000;
  const history = (messageRateLimit.get(socketId) ?? []).filter((ts) => ts > cutoff);
  if (history.length >= 10) {
    messageRateLimit.set(socketId, history);
    return false;
  }
  history.push(now);
  messageRateLimit.set(socketId, history);
  return true;
}

function emitError(socket: Socket, code: string, message: string): void {
  socket.emit("server-error", { code, message });
}

function cleanupRoom(roomId: string): void {
  if ((rooms[roomId]?.length ?? 0) === 0) {
    delete rooms[roomId];
    delete hosts[roomId];
    delete waitingRooms[roomId];
    delete polls[roomId];
  }
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

app.get("/readyz", (_req, res) => {
  res.status(200).json({ status: "ready", rooms: Object.keys(rooms).length });
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("join-room", (payload: { roomId: string; name: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const name = sanitizeText(payload?.name, `User ${socket.id.slice(0, 4)}`, 40);

    if (!isValidRoomId(roomId)) {
      emitError(socket, "INVALID_ROOM", "Room ID must be 3-64 characters (letters, numbers, _ or -).");
      return;
    }

    userNames[socket.id] = name;
    userStates[socket.id] = { isMuted: false, isVideoOff: false };

    if (!rooms[roomId]) {
      rooms[roomId] = [socket.id];
      hosts[roomId] = socket.id;
      socketRooms[socket.id] = roomId;
      socket.join(roomId);
      socket.emit("room-info", { hostId: socket.id, status: "joined" });
      console.log(`User ${socket.id} (${name}) created room ${roomId} as host`);
      return;
    }

    if ((rooms[roomId]?.length ?? 0) >= MAX_ROOM_SIZE) {
      emitError(socket, "ROOM_FULL", `Room is full. Maximum participant count is ${MAX_ROOM_SIZE}.`);
      return;
    }

    if (!waitingRooms[roomId]) waitingRooms[roomId] = [];
    if (waitingRooms[roomId].some((u) => u.id === socket.id)) {
      return;
    }

    if (waitingRooms[roomId].length >= MAX_WAITING_ROOM_SIZE) {
      emitError(socket, "WAITING_ROOM_FULL", "Waiting room is full. Please retry shortly.");
      return;
    }

    waitingRooms[roomId].push({ id: socket.id, name });
    socketRooms[socket.id] = roomId;
    socket.emit("room-info", { hostId: hosts[roomId], status: "waiting" });
    io.to(hosts[roomId]).emit("waiting-room-update", waitingRooms[roomId]);
    console.log(`User ${socket.id} (${name}) added to waiting room for ${roomId}`);
  });

  socket.on("admit-user", (payload: { roomId: string; userId: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const userId = sanitizeText(payload?.userId, "", 64);

    if (hosts[roomId] !== socket.id || !waitingRooms[roomId]) return;
    if ((rooms[roomId]?.length ?? 0) >= MAX_ROOM_SIZE) {
      emitError(socket, "ROOM_FULL", `Cannot admit more users. Maximum participant count is ${MAX_ROOM_SIZE}.`);
      return;
    }

    const userIndex = waitingRooms[roomId].findIndex((u) => u.id === userId);
    if (userIndex === -1) return;

    waitingRooms[roomId].splice(userIndex, 1);
    socket.emit("waiting-room-update", waitingRooms[roomId]);
    io.to(userId).emit("user-admitted", { roomId });
    console.log(`Host admitted user ${userId} to room ${roomId}`);
  });

  socket.on("reject-user", (payload: { roomId: string; userId: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const userId = sanitizeText(payload?.userId, "", 64);

    if (hosts[roomId] !== socket.id || !waitingRooms[roomId]) return;

    waitingRooms[roomId] = waitingRooms[roomId].filter((u) => u.id !== userId);
    socket.emit("waiting-room-update", waitingRooms[roomId]);
    io.to(userId).emit("user-rejected");
  });

  socket.on("complete-join", (roomIdRaw: string) => {
    const roomId = sanitizeText(roomIdRaw, "", 64);
    if (!roomId || !rooms[roomId]) {
      emitError(socket, "ROOM_NOT_FOUND", "Room no longer exists.");
      return;
    }

    if (!rooms[roomId].includes(socket.id) && rooms[roomId].length >= MAX_ROOM_SIZE) {
      emitError(socket, "ROOM_FULL", `Room is full. Maximum participant count is ${MAX_ROOM_SIZE}.`);
      return;
    }

    const otherUsers = rooms[roomId].filter((id) => id !== socket.id).map((id) => ({
      id,
      name: userNames[id] || `User ${id.substring(0, 4)}`,
      ...userStates[id],
    }));

    socket.emit("all-users", otherUsers);

    if (!rooms[roomId].includes(socket.id)) {
      rooms[roomId].push(socket.id);
    }

    socketRooms[socket.id] = roomId;
    socket.join(roomId);
    io.to(roomId).emit("room-info", { hostId: hosts[roomId], status: "joined" });

    socket.to(roomId).emit("user-joined", {
      callerId: socket.id,
      name: userNames[socket.id] || `User ${socket.id.substring(0, 4)}`,
      ...userStates[socket.id],
    });

    if (polls[roomId]) {
      socket.emit("polls-update", polls[roomId]);
    }

    console.log(`User ${socket.id} completed join for room ${roomId}`);
  });

  socket.on("host-action", (payload: { roomId: string; action: "mute-all" | "stop-video-all" | "end-meeting" }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const action = payload?.action;

    if (!roomId || hosts[roomId] !== socket.id) return;
    if (!["mute-all", "stop-video-all", "end-meeting"].includes(action)) return;

    io.to(roomId).emit("host-action", { action });
  });

  socket.on("sending-signal", (payload) => {
    io.to(payload.userToSignal).emit("user-joined", {
      signal: payload.signal,
      callerId: payload.callerId,
    });
  });

  socket.on("returning-signal", (payload) => {
    io.to(payload.callerId).emit("receiving-returned-signal", {
      signal: payload.signal,
      id: socket.id,
    });
  });

  socket.on("send-message", (payload: { roomId: string; text: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const text = sanitizeText(payload?.text, "", MAX_MESSAGE_LENGTH);

    if (!roomId || !text) return;
    if (!canSendMessage(socket.id)) {
      emitError(socket, "RATE_LIMIT", "You are sending messages too fast. Please slow down.");
      return;
    }

    io.to(roomId).emit("new-message", {
      sender: socket.id,
      text,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("hand-raise", (payload: { roomId: string; isHandRaised: boolean }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    io.to(roomId).emit("user-hand-raise", {
      userId: socket.id,
      isHandRaised: Boolean(payload?.isHandRaised),
    });
  });

  socket.on("reaction", (payload: { roomId: string; emoji: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const emoji = sanitizeText(payload?.emoji, "", 8);
    if (!emoji) return;

    io.to(roomId).emit("new-reaction", {
      userId: socket.id,
      emoji,
    });
  });

  socket.on("create-poll", (payload: { roomId: string; question: string; options: string[] }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    if (hosts[roomId] !== socket.id) return;

    const question = sanitizeText(payload?.question, "", 200);
    const options = Array.isArray(payload?.options)
      ? payload.options.map((option) => sanitizeText(option, "", 100)).filter(Boolean).slice(0, 10)
      : [];

    if (!question || options.length < 2) {
      emitError(socket, "INVALID_POLL", "Polls require a question and at least two options.");
      return;
    }

    if (!polls[roomId]) polls[roomId] = [];
    const newPoll: RoomPoll = {
      id: crypto.randomUUID(),
      question,
      options,
      votes: {},
      active: true,
      createdAt: new Date().toISOString(),
    };

    polls[roomId].push(newPoll);
    io.to(roomId).emit("polls-update", polls[roomId]);
  });

  socket.on("vote", (payload: { roomId: string; pollId: string; optionIndex: number }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const pollId = sanitizeText(payload?.pollId, "", 64);

    if (!polls[roomId]) return;
    const poll = polls[roomId].find((p) => p.id === pollId);
    if (!poll || !poll.active) return;

    if (!Number.isInteger(payload.optionIndex) || payload.optionIndex < 0 || payload.optionIndex >= poll.options.length) {
      emitError(socket, "INVALID_VOTE", "Invalid poll option.");
      return;
    }

    poll.votes[socket.id] = payload.optionIndex;
    io.to(roomId).emit("polls-update", polls[roomId]);
  });

  socket.on("end-poll", (payload: { roomId: string; pollId: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const pollId = sanitizeText(payload?.pollId, "", 64);

    if (hosts[roomId] !== socket.id || !polls[roomId]) return;
    const poll = polls[roomId].find((p) => p.id === pollId);
    if (!poll) return;

    poll.active = false;
    io.to(roomId).emit("polls-update", polls[roomId]);
  });

  socket.on("delete-poll", (payload: { roomId: string; pollId: string }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);
    const pollId = sanitizeText(payload?.pollId, "", 64);

    if (hosts[roomId] !== socket.id || !polls[roomId]) return;
    polls[roomId] = polls[roomId].filter((p) => p.id !== pollId);
    io.to(roomId).emit("polls-update", polls[roomId]);
  });

  socket.on("user-state-update", (payload: { roomId: string; isMuted: boolean; isVideoOff: boolean }) => {
    const roomId = sanitizeText(payload?.roomId, "", 64);

    userStates[socket.id] = {
      isMuted: Boolean(payload?.isMuted),
      isVideoOff: Boolean(payload?.isVideoOff),
    };

    socket.to(roomId).emit("remote-user-state-update", {
      userId: socket.id,
      ...userStates[socket.id],
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    messageRateLimit.delete(socket.id);

    for (const roomId of Object.keys(waitingRooms)) {
      waitingRooms[roomId] = waitingRooms[roomId].filter((u) => u.id !== socket.id);
      if (hosts[roomId]) {
        io.to(hosts[roomId]).emit("waiting-room-update", waitingRooms[roomId]);
      }
    }

    for (const roomId in rooms) {
      if (rooms[roomId].includes(socket.id)) {
        rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
        socket.to(roomId).emit("user-left", socket.id);

        if (hosts[roomId] === socket.id) {
          if (rooms[roomId].length > 0) {
            hosts[roomId] = rooms[roomId][0];
            io.to(roomId).emit("room-info", { hostId: hosts[roomId], status: "joined" });
            console.log(`Host left room ${roomId}. New host: ${hosts[roomId]}`);
          } else {
            delete hosts[roomId];
          }
        }

        cleanupRoom(roomId);
      }
    }

    delete socketRooms[socket.id];
    delete userNames[socket.id];
    delete userStates[socket.id];
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    io.close(() => {
      httpServer.close(() => {
        process.exit(0);
      });
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
