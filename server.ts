import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  const PORT = 3000;

  // Room management
  const rooms: Record<string, string[]> = {};
  const hosts: Record<string, string> = {};

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId: string) => {
      if (!rooms[roomId]) {
        rooms[roomId] = [];
        hosts[roomId] = socket.id; // First user is the host
      }
      
      // Notify others in the room
      const otherUsers = rooms[roomId];
      socket.emit("all-users", otherUsers);
      
      rooms[roomId].push(socket.id);
      socket.join(roomId);
      
      // Send host info to the new user
      io.to(roomId).emit("room-info", { hostId: hosts[roomId] });
      
      console.log(`User ${socket.id} joined room ${roomId}. Host: ${hosts[roomId]}`);
    });

    socket.on("host-action", (payload) => {
      const { roomId, action } = payload;
      // Only the host can perform these actions
      if (hosts[roomId] === socket.id) {
        io.to(roomId).emit("host-action", { action });
      }
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

    socket.on("send-message", (payload) => {
      io.to(payload.roomId).emit("new-message", {
        sender: socket.id,
        text: payload.text,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on("hand-raise", (payload) => {
      io.to(payload.roomId).emit("user-hand-raise", {
        userId: socket.id,
        isHandRaised: payload.isHandRaised,
      });
    });

    socket.on("reaction", (payload) => {
      io.to(payload.roomId).emit("new-reaction", {
        userId: socket.id,
        emoji: payload.emoji,
      });
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      for (const roomId in rooms) {
        if (rooms[roomId].includes(socket.id)) {
          rooms[roomId] = rooms[roomId].filter((id) => id !== socket.id);
          socket.to(roomId).emit("user-left", socket.id);
          
          // If host left, assign a new host
          if (hosts[roomId] === socket.id) {
            if (rooms[roomId].length > 0) {
              hosts[roomId] = rooms[roomId][0];
              io.to(roomId).emit("room-info", { hostId: hosts[roomId] });
              console.log(`Host left room ${roomId}. New host: ${hosts[roomId]}`);
            } else {
              delete hosts[roomId];
              delete rooms[roomId];
            }
          }
        }
      }
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
