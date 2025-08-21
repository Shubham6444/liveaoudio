import express from "express"
import { createServer } from "http"
import { Server } from "socket.io" // Correct import
import path from "path"
import { fileURLToPath } from "url"

const app = express()
const server = createServer(app)

// Correct the instantiation of the Socket.IO server
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins (update this for better security in production)
    methods: ["GET", "POST"],
  },
})

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Serve static files
app.use(express.static(path.join(__dirname, "public")))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})
app.get("/1", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "demo.html"))
})

const rooms = new Map()
const userProfiles = new Map() // Store user profiles: socketId -> { name, avatar, joinedAt }
const roomParticipants = new Map() // Store room participants: roomName -> Map(socketId -> { isAdmin, isMuted, mutedByAdmin, profile })

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`)

  socket.on("join-room", ({ username, room }) => {
    socket.join(room)

    const userProfile = {
      username: username || `User${socket.id.slice(-4)}`,
      avatar: username ? username.charAt(0).toUpperCase() : socket.id.slice(-2).toUpperCase(),
      joinedAt: new Date().toISOString(),
    }
    userProfiles.set(socket.id, userProfile)

    if (!roomParticipants.has(room)) {
      roomParticipants.set(room, new Map())
    }

    const participants = roomParticipants.get(room)
    const isFirstUser = participants.size === 0

    participants.set(socket.id, {
      socketId: socket.id,
      isAdmin: isFirstUser,
      isMuted: false,
      mutedByAdmin: false,
      profile: userProfile,
      ...userProfile,
    })

    if (!rooms.has(room)) {
      rooms.set(room, new Set())
    }
    rooms.get(room).add(socket.id)

    socket.emit("room-joined", {
      isAdmin: isFirstUser,
      participants: Array.from(participants.values()),
    })

    const existingParticipants = Array.from(participants.values()).filter((p) => p.socketId !== socket.id)
    socket.emit("existing-participants", existingParticipants)

    socket.to(room).emit("user-joined", participants.get(socket.id))

    io.to(room).emit("participants-updated", Array.from(participants.values()))
  })

  socket.on("toggle-mute", ({ isMuted }) => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      const participants = roomParticipants.get(room)
      if (participants && participants.has(socket.id)) {
        const participant = participants.get(socket.id)

        if (participant.mutedByAdmin && participant.isMuted && !isMuted) {
          socket.emit("admin-mute-prevented")
          return
        }

        participant.isMuted = isMuted
        if (!isMuted) {
          participant.mutedByAdmin = false
        }
        participants.set(socket.id, participant)

        io.to(room).emit("user-muted", { socketId: socket.id, isMuted })
        io.to(room).emit("participants-updated", Array.from(participants.values()))
      }
    })
  })

  socket.on("admin-mute-user", ({ socketId }) => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      const participants = roomParticipants.get(room)
      if (participants && participants.has(socket.id) && participants.get(socket.id).isAdmin) {
        const targetUser = participants.get(socketId)
        if (targetUser) {
          targetUser.isMuted = !targetUser.isMuted
          targetUser.mutedByAdmin = targetUser.isMuted
          participants.set(socketId, targetUser)

          if (targetUser.isMuted) {
            io.to(socketId).emit("force-mute", { socketId })
          } else {
            io.to(socketId).emit("force-unmute", { socketId })
          }

          io.to(room).emit("user-muted", { socketId, isMuted: targetUser.isMuted })
          io.to(room).emit("participants-updated", Array.from(participants.values()))
        }
      }
    })
  })

  socket.on("admin-remove-user", ({ socketId }) => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      const participants = roomParticipants.get(room)
      if (participants && participants.has(socket.id) && participants.get(socket.id).isAdmin) {
        participants.delete(socketId)
        rooms.get(room)?.delete(socketId)

        io.to(socketId).emit("user-removed", { socketId })

        const removedSocket = io.sockets.sockets.get(socketId)
        if (removedSocket) {
          removedSocket.leave(room)
        }

        io.to(room).emit("user-left", { socketId })
        io.to(room).emit("participants-updated", Array.from(participants.values()))
      }
    })
  })

  socket.on("admin-mute-all", () => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      const participants = roomParticipants.get(room)
      if (participants && participants.has(socket.id) && participants.get(socket.id).isAdmin) {
        participants.forEach((participant, participantId) => {
          if (!participant.isAdmin && participantId !== socket.id) {
            participant.isMuted = true
            participant.mutedByAdmin = true
            participants.set(participantId, participant)
            io.to(participantId).emit("force-mute", { socketId: participantId })
          }
        })

        io.to(room).emit("participants-updated", Array.from(participants.values()))
      }
    })
  })

  socket.on("admin-unmute-all", () => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      const participants = roomParticipants.get(room)
      if (participants && participants.has(socket.id) && participants.get(socket.id).isAdmin) {
        participants.forEach((participant, participantId) => {
          if (participantId !== socket.id) {
            participant.isMuted = false
            participant.mutedByAdmin = false
            participants.set(participantId, participant)
            io.to(participantId).emit("force-unmute", { socketId: participantId })
          }
        })

        io.to(room).emit("participants-updated", Array.from(participants.values()))
      }
    })
  })

  socket.on("leave-room", () => {
    const userRooms = Array.from(socket.rooms).filter((room) => room !== socket.id)

    userRooms.forEach((room) => {
      socket.leave(room)
      const participants = roomParticipants.get(room)
      if (participants) {
        const wasAdmin = participants.get(socket.id)?.isAdmin
        participants.delete(socket.id)

        if (wasAdmin && participants.size > 0) {
          const nextAdmin = participants.values().next().value
          if (nextAdmin) {
            nextAdmin.isAdmin = true
            participants.set(nextAdmin.socketId, nextAdmin)
            io.to(nextAdmin.socketId).emit("promoted-to-admin")
          }
        }

        if (rooms.has(room)) {
          rooms.get(room).delete(socket.id)
          if (rooms.get(room).size === 0) {
            rooms.delete(room)
            roomParticipants.delete(room)
          } else {
            io.to(room).emit("user-left", { socketId: socket.id })
            io.to(room).emit("participants-updated", Array.from(participants.values()))
          }
        }
      }
    })
  })

  socket.on("voice-activity", ({ userId, room }) => {
    if (room) {
      const userProfile = userProfiles.get(userId)
      socket.to(room).emit("voice-activity", {
        userId,
        profile: userProfile,
      })
    }
  })

  socket.on("voice-muted", ({ userId, room }) => {
    if (room) {
      const userProfile = userProfiles.get(userId)
      socket.to(room).emit("voice-muted", {
        userId,
        profile: userProfile,
      })
    }
  })

  socket.on("offer", (socketId, description) => {
    console.log(`[Server] Relaying offer from ${socket.id} to ${socketId}`)
    socket.to(socketId).emit("offer", socket.id, description)
  })

  socket.on("answer", (socketId, description) => {
    console.log(`[Server] Relaying answer from ${socket.id} to ${socketId}`)
    socket.to(socketId).emit("answer", socket.id, description)
  })

  socket.on("candidate", (socketId, candidate) => {
    console.log(`[Server] Relaying ICE candidate from ${socket.id} to ${socketId}`)
    socket.to(socketId).emit("candidate", socket.id, candidate)
  })

  socket.on("chat-message", ({ room, message }) => {
    const userProfile = userProfiles.get(socket.id)
    socket.to(room).emit("chat-message", {
      sender: socket.id,
      message,
      profile: userProfile,
    })
  })

  socket.on("disconnecting", () => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        const participants = roomParticipants.get(room)
        if (participants) {
          const wasAdmin = participants.get(socket.id)?.isAdmin
          participants.delete(socket.id)

          if (wasAdmin && participants.size > 0) {
            const nextAdmin = participants.values().next().value
            if (nextAdmin) {
              nextAdmin.isAdmin = true
              participants.set(nextAdmin.socketId, nextAdmin)
              io.to(nextAdmin.socketId).emit("promoted-to-admin")
            }
          }

          if (rooms.has(room)) {
            rooms.get(room).delete(socket.id)
            if (rooms.get(room).size === 0) {
              rooms.delete(room)
              roomParticipants.delete(room)
            } else {
              io.to(room).emit("user-left", { socketId: socket.id })
              io.to(room).emit("participants-updated", Array.from(participants.values()))
            }
          }
        }
      }
    }
    userProfiles.delete(socket.id)
  })

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`)
    userProfiles.delete(socket.id)
  })
})

const PORT = process.env.PORT || 9000
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})
