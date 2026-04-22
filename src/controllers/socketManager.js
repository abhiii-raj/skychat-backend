import { Server } from "socket.io"


let connections = {}
let messages = {}
let timeOnline = {}
let userSockets = {}
let socketToUser = {}
let callSessions = {}
let callTimeouts = {}

const normalizeUserId = (userId) => String(userId || "").trim();

const isUserOnlineInternal = (userId) => {
    const normalizedUserId = normalizeUserId(userId);
    if (!normalizedUserId) return false;
    return Array.isArray(userSockets[normalizedUserId]) && userSockets[normalizedUserId].length > 0;
};

export const isUserOnline = (userId) => isUserOnlineInternal(userId);

const RING_TIMEOUT_MS = 30000;

const makeCallId = () => `call-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const clearCallTimeout = (callId) => {
    if (callTimeouts[callId]) {
        clearTimeout(callTimeouts[callId]);
        delete callTimeouts[callId];
    }
};

const userInActiveCall = (userId) => {
    return Object.values(callSessions).some((session) => {
        const involved = session.callerId === userId || session.calleeId === userId;
        const active = session.status === "ringing" || session.status === "in-call";
        return involved && active;
    });
};

const removeCallSession = (callId) => {
    clearCallTimeout(callId);
    delete callSessions[callId];
};

export const connectToSocket = (server) => {
    const io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            allowedHeaders: ["*"],
            credentials: true
        }
    });


    io.on("connection", (socket) => {

        console.log("SOMETHING CONNECTED")

        socket.on("register-user", (userId) => {
            const normalizedUserId = normalizeUserId(userId);
            if (!normalizedUserId) return;

            const wasOnline = isUserOnlineInternal(normalizedUserId);

            socketToUser[socket.id] = normalizedUserId;
            if (!userSockets[normalizedUserId]) {
                userSockets[normalizedUserId] = [];
            }

            if (!userSockets[normalizedUserId].includes(socket.id)) {
                userSockets[normalizedUserId].push(socket.id);
            }

            socket.join(`user:${normalizedUserId}`);

            if (!wasOnline) {
                io.emit("user_presence_update", { userId: normalizedUserId, isOnline: true });
            }
        });

        socket.on("place_call", (payload = {}) => {
            const fromUserId = String(payload.fromUserId || socketToUser[socket.id] || "").trim();
            const toUserId = String(payload.toUserId || "").trim();
            const callType = payload.callType === "video" ? "video" : "voice";
            const roomCode = String(payload.roomCode || "").trim() || `dm-${toUserId}-${Date.now()}`;

            if (!fromUserId || !toUserId) {
                socket.emit("call_failed", { message: "Invalid caller or recipient" });
                return;
            }

            const recipientSockets = userSockets[toUserId] || [];
            if (recipientSockets.length === 0) {
                socket.emit("call_unavailable", { toUserId, callType, reason: "offline" });
                return;
            }

            if (fromUserId === toUserId) {
                socket.emit("call_unavailable", { toUserId, callType, reason: "invalid-recipient" });
                return;
            }

            if (userInActiveCall(toUserId)) {
                socket.emit("call_unavailable", { toUserId, callType, reason: "busy" });
                return;
            }

            if (userInActiveCall(fromUserId)) {
                socket.emit("call_unavailable", { toUserId, callType, reason: "caller-busy" });
                return;
            }

            const callId = makeCallId();
            callSessions[callId] = {
                callId,
                callerId: fromUserId,
                calleeId: toUserId,
                roomCode,
                callType,
                status: "ringing",
                createdAt: Date.now()
            };

            io.to(`user:${fromUserId}`).emit("call_ringing", {
                callId,
                roomCode,
                callType,
                toUserId
            });

            io.to(`user:${toUserId}`).emit("incoming_call", {
                callId,
                roomCode,
                callType,
                conversationId: payload.conversationId,
                fromUser: payload.fromUser,
                fromUserId,
                toUserId
            });

            callTimeouts[callId] = setTimeout(() => {
                const session = callSessions[callId];
                if (!session || session.status !== "ringing") {
                    removeCallSession(callId);
                    return;
                }

                io.to(`user:${session.callerId}`).emit("call_missed", {
                    callId: session.callId,
                    byUserId: session.calleeId,
                    reason: "timeout"
                });

                io.to(`user:${session.calleeId}`).emit("call_missed", {
                    callId: session.callId,
                    byUserId: session.calleeId,
                    reason: "timeout"
                });

                removeCallSession(callId);
            }, RING_TIMEOUT_MS);
        });

        socket.on("place_group_call", (payload = {}) => {
            const fromUserId = String(payload.fromUserId || socketToUser[socket.id] || "").trim();
            const callType = payload.callType === "voice" ? "voice" : "video";
            const roomCode = String(payload.roomCode || "").trim() || `group-${Date.now()}`;
            const toUserIds = Array.isArray(payload.toUserIds) ? payload.toUserIds.map((id) => String(id || "").trim()).filter(Boolean) : [];

            if (!fromUserId || toUserIds.length === 0) {
                socket.emit("call_failed", { message: "Invalid group call payload" });
                return;
            }

            const uniqueTargets = [...new Set(toUserIds.filter((id) => id !== fromUserId))];
            if (uniqueTargets.length === 0) {
                socket.emit("call_unavailable", { reason: "no-targets", callType });
                return;
            }

            uniqueTargets.forEach((toUserId) => {
                const recipientSockets = userSockets[toUserId] || [];
                if (recipientSockets.length === 0 || userInActiveCall(toUserId)) {
                    return;
                }

                const callId = makeCallId();
                callSessions[callId] = {
                    callId,
                    callerId: fromUserId,
                    calleeId: toUserId,
                    roomCode,
                    callType,
                    status: "ringing",
                    createdAt: Date.now()
                };

                io.to(`user:${fromUserId}`).emit("call_ringing", {
                    callId,
                    roomCode,
                    callType,
                    toUserId
                });

                io.to(`user:${toUserId}`).emit("incoming_call", {
                    callId,
                    roomCode,
                    callType,
                    conversationId: payload.conversationId,
                    fromUser: payload.fromUser,
                    fromUserId,
                    toUserId
                });

                callTimeouts[callId] = setTimeout(() => {
                    const session = callSessions[callId];
                    if (!session || session.status !== "ringing") {
                        removeCallSession(callId);
                        return;
                    }

                    io.to(`user:${session.callerId}`).emit("call_missed", {
                        callId: session.callId,
                        byUserId: session.calleeId,
                        reason: "timeout"
                    });

                    io.to(`user:${session.calleeId}`).emit("call_missed", {
                        callId: session.callId,
                        byUserId: session.calleeId,
                        reason: "timeout"
                    });

                    removeCallSession(callId);
                }, RING_TIMEOUT_MS);
            });
        });

        socket.on("accept_call", ({ callId, userId } = {}) => {
            const session = callSessions[callId];
            if (!session) return;

            const actorUserId = String(userId || socketToUser[socket.id] || "").trim();
            if (!actorUserId || actorUserId !== session.calleeId) return;

            session.status = "in-call";
            clearCallTimeout(callId);

            io.to(`user:${session.callerId}`).emit("call_accepted", {
                callId: session.callId,
                roomCode: session.roomCode,
                callType: session.callType,
                byUserId: actorUserId
            });

            io.to(`user:${session.calleeId}`).emit("call_accepted", {
                callId: session.callId,
                roomCode: session.roomCode,
                callType: session.callType,
                byUserId: actorUserId
            });
        });

        socket.on("reject_call", ({ callId, userId } = {}) => {
            const session = callSessions[callId];
            if (!session) return;

            const actorUserId = String(userId || socketToUser[socket.id] || "").trim();
            if (!actorUserId) return;

            io.to(`user:${session.callerId}`).emit("call_rejected", {
                callId: session.callId,
                byUserId: actorUserId
            });

            io.to(`user:${session.calleeId}`).emit("call_rejected", {
                callId: session.callId,
                byUserId: actorUserId
            });

            removeCallSession(callId);
        });

        socket.on("end_call", ({ callId, userId } = {}) => {
            const session = callSessions[callId];
            if (!session) return;

            const actorUserId = String(userId || socketToUser[socket.id] || "").trim();

            io.to(`user:${session.callerId}`).emit("call_ended", {
                callId: session.callId,
                byUserId: actorUserId
            });

            io.to(`user:${session.calleeId}`).emit("call_ended", {
                callId: session.callId,
                byUserId: actorUserId
            });

            removeCallSession(callId);
        });

        socket.on("join-call", (path) => {

            if (connections[path] === undefined) {
                connections[path] = []
            }
            connections[path].push(socket.id)

            timeOnline[socket.id] = new Date();

            // connections[path].forEach(elem => {
            //     io.to(elem)
            // })

            for (let a = 0; a < connections[path].length; a++) {
                io.to(connections[path][a]).emit("user-joined", socket.id, connections[path])
            }

            if (messages[path] !== undefined) {
                for (let a = 0; a < messages[path].length; ++a) {
                    io.to(socket.id).emit("chat-message", messages[path][a]['data'],
                        messages[path][a]['sender'], messages[path][a]['socket-id-sender'])
                }
            }

        })

        socket.on("signal", (toId, message) => {
            io.to(toId).emit("signal", socket.id, message);
        })

        socket.on("chat-message", (data, sender) => {

            const [matchingRoom, found] = Object.entries(connections)
                .reduce(([room, isFound], [roomKey, roomValue]) => {


                    if (!isFound && roomValue.includes(socket.id)) {
                        return [roomKey, true];
                    }

                    return [room, isFound];

                }, ['', false]);

            if (found === true) {
                if (messages[matchingRoom] === undefined) {
                    messages[matchingRoom] = []
                }

                messages[matchingRoom].push({ 'sender': sender, "data": data, "socket-id-sender": socket.id })
                console.log("message", matchingRoom, ":", sender, data)

                connections[matchingRoom].forEach((elem) => {
                    io.to(elem).emit("chat-message", data, sender, socket.id)
                })
            }

        })

        socket.on("typing", (payload = {}) => {
            const fromUserId = normalizeUserId(payload.fromUserId || socketToUser[socket.id]);
            const toUserId = normalizeUserId(payload.toUserId);
            const senderName = String(payload.senderName || "").trim();

            if (!fromUserId || !toUserId) return;

            io.to(`user:${toUserId}`).emit("typing", {
                conversationId: `dm-${fromUserId}`,
                senderName,
                fromUserId,
                toUserId,
            });
        });

        socket.on("stop_typing", (payload = {}) => {
            const fromUserId = normalizeUserId(payload.fromUserId || socketToUser[socket.id]);
            const toUserId = normalizeUserId(payload.toUserId);

            if (!fromUserId || !toUserId) return;

            io.to(`user:${toUserId}`).emit("stop_typing", {
                conversationId: `dm-${fromUserId}`,
                fromUserId,
                toUserId,
            });
        });

        socket.on("disconnect", () => {
            const disconnectedUserId = socketToUser[socket.id];

            if (disconnectedUserId && userSockets[disconnectedUserId]) {
                userSockets[disconnectedUserId] = userSockets[disconnectedUserId].filter((id) => id !== socket.id);
                if (userSockets[disconnectedUserId].length === 0) {
                    delete userSockets[disconnectedUserId];
                    io.emit("user_presence_update", { userId: disconnectedUserId, isOnline: false });
                }
            }

            delete socketToUser[socket.id];

            var key

            for (const [k, v] of JSON.parse(JSON.stringify(Object.entries(connections)))) {

                for (let a = 0; a < v.length; ++a) {
                    if (v[a] === socket.id) {
                        key = k

                        for (let a = 0; a < connections[key].length; ++a) {
                            io.to(connections[key][a]).emit('user-left', socket.id)
                        }

                        var index = connections[key].indexOf(socket.id)

                        connections[key].splice(index, 1)


                        if (connections[key].length === 0) {
                            delete connections[key]
                        }
                    }
                }

            }

            for (const [callId, session] of Object.entries({ ...callSessions })) {
                if (session.callerId !== disconnectedUserId && session.calleeId !== disconnectedUserId) {
                    continue;
                }

                const otherUserId = session.callerId === disconnectedUserId ? session.calleeId : session.callerId;

                if (session.status === "ringing") {
                    io.to(`user:${otherUserId}`).emit("call_missed", {
                        callId: session.callId,
                        byUserId: disconnectedUserId,
                        reason: "disconnected"
                    });
                } else {
                    io.to(`user:${otherUserId}`).emit("call_ended", {
                        callId: session.callId,
                        byUserId: disconnectedUserId
                    });
                }

                removeCallSession(callId);
            }


        })


    })


    return io;
}

