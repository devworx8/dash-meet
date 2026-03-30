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
  const waitingRooms: Record<string, { id: string, name: string }[]> = {};
  const polls: Record<string, any[]> = {};
  const userNames: Record<string, string> = {};

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (payload: { roomId: string, name: string }) => {
      const { roomId, name } = payload;
      userNames[socket.id] = name;
      
      if (!rooms[roomId]) {
        // First user becomes host and joins immediately
        rooms[roomId] = [socket.id];
        hosts[roomId] = socket.id;
        socket.join(roomId);
        socket.emit("room-info", { hostId: socket.id, status: 'joined' });
        console.log(`User ${socket.id} (${name}) created room ${roomId} as host`);
      } else {
        // Subsequent users go to waiting room
        if (!waitingRooms[roomId]) waitingRooms[roomId] = [];
        waitingRooms[roomId].push({ id: socket.id, name });
        
        socket.emit("room-info", { hostId: hosts[roomId], status: 'waiting' });
        
        // Notify host about the new waiting user
        io.to(hosts[roomId]).emit("waiting-room-update", waitingRooms[roomId]);
        console.log(`User ${socket.id} (${name}) added to waiting room for ${roomId}`);
      }
    });

    socket.on("admit-user", (payload: { roomId: string, userId: string }) => {
      const { roomId, userId } = payload;
      if (hosts[roomId] === socket.id && waitingRooms[roomId]) {
        const userIndex = waitingRooms[roomId].findIndex(u => u.id === userId);
        if (userIndex !== -1) {
          const user = waitingRooms[roomId][userIndex];
          waitingRooms[roomId].splice(userIndex, 1);
          
          // Notify host of updated list
          socket.emit("waiting-room-update", waitingRooms[roomId]);
          
          // Tell the user they are admitted
          io.to(userId).emit("user-admitted", { roomId });
          
          // The user will then emit 'complete-join'
          console.log(`Host admitted user ${userId} to room ${roomId}`);
        }
      }
    });

    socket.on("reject-user", (payload: { roomId: string, userId: string }) => {
      const { roomId, userId } = payload;
      if (hosts[roomId] === socket.id && waitingRooms[roomId]) {
        waitingRooms[roomId] = waitingRooms[roomId].filter(u => u.id !== userId);
        socket.emit("waiting-room-update", waitingRooms[roomId]);
        io.to(userId).emit("user-rejected");
      }
    });

    socket.on("complete-join", (roomId: string) => {
      if (!rooms[roomId]) rooms[roomId] = [];
      
      // Notify others in the room
      const otherUsers = rooms[roomId].filter(id => id !== socket.id).map(id => ({
        id,
        name: userNames[id] || `User ${id.substring(0, 4)}`
      }));
      socket.emit("all-users", otherUsers);
      
      if (!rooms[roomId].includes(socket.id)) {
        rooms[roomId].push(socket.id);
      }
      socket.join(roomId);
      
      io.to(roomId).emit("room-info", { hostId: hosts[roomId], status: 'joined' });
      
      // Notify others that a new user joined with their name
      socket.to(roomId).emit("user-joined", {
        callerId: socket.id,
        name: userNames[socket.id] || `User ${socket.id.substring(0, 4)}`
      });
      
      // Send existing polls to the new user
      if (polls[roomId]) {
        socket.emit("polls-update", polls[roomId]);
      }
      
      console.log(`User ${socket.id} completed join for room ${roomId}`);
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

    socket.on("create-poll", (payload: { roomId: string, question: string, options: string[] }) => {
      const { roomId, question, options } = payload;
      if (hosts[roomId] === socket.id) {
        if (!polls[roomId]) polls[roomId] = [];
        const newPoll = {
          id: Math.random().toString(36).substring(2, 9),
          question,
          options,
          votes: {}, // userId -> optionIndex
          active: true,
          createdAt: new Date().toISOString()
        };
        polls[roomId].push(newPoll);
        io.to(roomId).emit("polls-update", polls[roomId]);
      }
    });

    socket.on("vote", (payload: { roomId: string, pollId: string, optionIndex: number }) => {
      const { roomId, pollId, optionIndex } = payload;
      if (polls[roomId]) {
        const poll = polls[roomId].find(p => p.id === pollId);
        if (poll && poll.active) {
          poll.votes[socket.id] = optionIndex;
          io.to(roomId).emit("polls-update", polls[roomId]);
        }
      }
    });

    socket.on("end-poll", (payload: { roomId: string, pollId: string }) => {
      const { roomId, pollId } = payload;
      if (hosts[roomId] === socket.id && polls[roomId]) {
        const poll = polls[roomId].find(p => p.id === pollId);
        if (poll) {
          poll.active = false;
          io.to(roomId).emit("polls-update", polls[roomId]);
        }
      }
    });

    socket.on("delete-poll", (payload: { roomId: string, pollId: string }) => {
      const { roomId, pollId } = payload;
      if (hosts[roomId] === socket.id && polls[roomId]) {
        polls[roomId] = polls[roomId].filter(p => p.id !== pollId);
        io.to(roomId).emit("polls-update", polls[roomId]);
      }
    });

    socket.on("user-state-update", (payload: { roomId: string, isMuted: boolean, isVideoOff: boolean }) => {
      const { roomId, isMuted, isVideoOff } = payload;
      socket.to(roomId).emit("remote-user-state-update", {
        userId: socket.id,
        isMuted,
        isVideoOff
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
