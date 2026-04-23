import httpStatus from "http-status";
import { User } from "../models/user.model.js";
import bcrypt, { hash } from "bcrypt"

import crypto from "crypto"
import { Meeting } from "../models/meeting.model.js";
import { Group } from "../models/group.model.js";
import mongoose from "mongoose";
import { isUserOnline } from "./socketManager.js";

const messageSchema = new mongoose.Schema(
    {
        sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        recipient: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        content: { type: String, trim: true, default: "" },
        type: { type: String, enum: ["text", "file"], default: "text" },
        file: {
            name: { type: String },
            mimeType: { type: String },
            size: { type: Number },
            url: { type: String }
        },
    },
    { timestamps: true }
);

const Message = mongoose.models.Message || mongoose.model("Message", messageSchema);

const friendRequestSchema = new mongoose.Schema(
    {
        from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        to: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        status: { type: String, enum: ["pending", "accepted", "rejected"], default: "pending" },
    },
    { timestamps: true }
);

friendRequestSchema.index({ from: 1, to: 1 }, { unique: true });

const FriendRequest = mongoose.models.FriendRequest || mongoose.model("FriendRequest", friendRequestSchema);

const toPublicUser = (u) => ({
    _id: u._id,
    name: u.name,
    username: u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    isOnline: isUserOnline(u?._id),
});

const getTokenFromRequest = (req) => {
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
        return authHeader.slice(7).trim();
    }
    return req.query.token || req.body.token;
};

const getCurrentUserFromRequest = async (req) => {
    const token = getTokenFromRequest(req);
    if (!token) return null;
    return User.findOne({ token });
};

const areUsersFriends = async (userIdA, userIdB) => {
    if (!userIdA || !userIdB) return false;
    const exists = await User.exists({ _id: userIdA, friends: userIdB });
    return Boolean(exists);
};

const getFriendshipMeta = async (currentUser) => {
    const me = await User.findById(currentUser._id, { friends: 1 }).lean();
    const friendIdSet = new Set((me?.friends || []).map((id) => String(id)));

    const requests = await FriendRequest.find({
        status: "pending",
        $or: [{ from: currentUser._id }, { to: currentUser._id }]
    }, { from: 1, to: 1 }).lean();

    const sentToMap = new Map();
    const receivedFromMap = new Map();

    requests.forEach((request) => {
        const fromId = String(request.from);
        const toId = String(request.to);

        if (fromId === String(currentUser._id)) {
            sentToMap.set(toId, String(request._id));
            return;
        }

        if (toId === String(currentUser._id)) {
            receivedFromMap.set(fromId, String(request._id));
        }
    });

    return { friendIdSet, sentToMap, receivedFromMap };
};

const getFriendshipStatusForUser = (userId, friendshipMeta) => {
    const normalizedUserId = String(userId);
    if (friendshipMeta.friendIdSet.has(normalizedUserId)) {
        return { friendshipStatus: "friend", friendRequestId: null };
    }

    if (friendshipMeta.sentToMap.has(normalizedUserId)) {
        return {
            friendshipStatus: "pending_sent",
            friendRequestId: friendshipMeta.sentToMap.get(normalizedUserId)
        };
    }

    if (friendshipMeta.receivedFromMap.has(normalizedUserId)) {
        return {
            friendshipStatus: "pending_received",
            friendRequestId: friendshipMeta.receivedFromMap.get(normalizedUserId)
        };
    }

    return { friendshipStatus: "none", friendRequestId: null };
};

const login = async (req, res) => {

    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: "Please Provide" })
    }

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "User Not Found" })
        }


        let isPasswordCorrect = await bcrypt.compare(password, user.password)

        if (isPasswordCorrect) {
            let token = crypto.randomBytes(20).toString("hex");

            user.token = token;
            await user.save();
            return res.status(httpStatus.OK).json({
                token: token,
                user: {
                    _id: user._id,
                    name: user.name,
                    username: user.username,
                    bio: user.bio || "",
                    avatarUrl: user.avatarUrl || ""
                }
            })
        } else {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Invalid Username or password" })
        }

    } catch (e) {
        return res.status(500).json({ message: `Something went wrong ${e}` })
    }
}

const getAllUsers = async (req, res) => {
    try {
        const token = getTokenFromRequest(req);
        const currentUser = token ? await User.findOne({ token }) : null;
        const friendshipMeta = currentUser ? await getFriendshipMeta(currentUser) : null;

        const users = await User.find({}, { name: 1, username: 1, bio: 1, avatarUrl: 1 }).lean();

        const filteredUsers = users
            .filter((u) => !currentUser || String(u._id) !== String(currentUser._id))
            .map((u) => {
                const friendship = friendshipMeta
                    ? getFriendshipStatusForUser(u._id, friendshipMeta)
                    : { friendshipStatus: "none", friendRequestId: null };

                return {
                    _id: u._id,
                    name: u.name,
                    username: u.username,
                    bio: u.bio || "",
                    avatarUrl: u.avatarUrl || "",
                    isOnline: isUserOnline(u?._id),
                    friendshipStatus: friendship.friendshipStatus,
                    friendRequestId: friendship.friendRequestId,
                };
            });

        return res.status(httpStatus.OK).json(filteredUsers);
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
}

const getContacts = async (req, res) => {
    return getAllUsers(req, res);
};

const getAllConversations = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const me = await User.findById(currentUser._id, { friends: 1 }).lean();
        const friendIds = me?.friends || [];

        const users = await User.find(
            { _id: { $in: friendIds } },
            { name: 1, username: 1, bio: 1, avatarUrl: 1 }
        ).lean();

        const dmConversations = await Promise.all(
            users.map(async (peer) => {
                const lastMessage = await Message.findOne({
                    $or: [
                        { sender: currentUser._id, recipient: peer._id },
                        { sender: peer._id, recipient: currentUser._id }
                    ]
                })
                    .sort({ createdAt: -1 })
                    .populate("sender", "_id name username")
                    .lean();

                return {
                    _id: `dm-${peer._id}`,
                    isGroup: false,
                    participants: [
                        toPublicUser(currentUser),
                        toPublicUser(peer)
                    ],
                    lastMessage: lastMessage
                        ? {
                            _id: lastMessage._id,
                            content: lastMessage.type === "file"
                                ? `Attachment: ${lastMessage.file?.name || "file"}`
                                : lastMessage.content,
                            createdAt: lastMessage.createdAt,
                            sender: lastMessage.sender,
                            type: lastMessage.type,
                            file: lastMessage.file
                        }
                        : null,
                    unreadCount: 0,
                    updatedAt: lastMessage?.createdAt || peer.updatedAt || peer.createdAt,
                };
            })
        );

        const groups = await Group.find({ members: currentUser._id })
            .populate("members", "_id name username bio avatarUrl")
            .lean();

        const groupConversations = groups.map((group) => ({
            _id: `grp-${group._id}`,
            name: group.name,
            isGroup: true,
            participants: (group.members || []).map(toPublicUser),
            lastMessage: null,
            unreadCount: 0,
            updatedAt: group.updatedAt || group.createdAt,
        }));

        const conversations = [...dmConversations, ...groupConversations];
        conversations.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        return res.status(httpStatus.OK).json(conversations);
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const getConversationById = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const rawConversationId = String(req.params.id || "");
        if (rawConversationId.startsWith("grp-")) {
            const groupId = rawConversationId.replace("grp-", "");
            if (!mongoose.Types.ObjectId.isValid(groupId)) {
                return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid conversation id" });
            }

            const group = await Group.findOne({ _id: groupId, members: currentUser._id })
                .populate("members", "_id name username bio avatarUrl")
                .lean();

            if (!group) {
                return res.status(httpStatus.NOT_FOUND).json({ message: "Conversation not found" });
            }

            return res.status(httpStatus.OK).json({
                _id: `grp-${group._id}`,
                name: group.name,
                isGroup: true,
                participants: (group.members || []).map(toPublicUser),
                lastMessage: null,
                unreadCount: 0,
            });
        }

        const peerId = rawConversationId.replace("dm-", "");
        if (!mongoose.Types.ObjectId.isValid(peerId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid conversation id" });
        }

        const peer = await User.findById(peerId, { name: 1, username: 1, bio: 1, avatarUrl: 1 }).lean();
        if (!peer) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Conversation not found" });
        }

        const isFriend = await areUsersFriends(currentUser._id, peer._id);
        if (!isFriend) {
            return res.status(httpStatus.FORBIDDEN).json({ message: "Add this user as a friend to start chatting" });
        }

        const lastMessage = await Message.findOne({
            $or: [
                { sender: currentUser._id, recipient: peer._id },
                { sender: peer._id, recipient: currentUser._id }
            ]
        })
            .sort({ createdAt: -1 })
            .populate("sender", "_id name username")
            .lean();

        return res.status(httpStatus.OK).json({
            _id: `dm-${peer._id}`,
            isGroup: false,
            participants: [
                toPublicUser(currentUser),
                toPublicUser(peer)
            ],
            lastMessage: lastMessage
                ? {
                    _id: lastMessage._id,
                    content: lastMessage.type === "file"
                        ? `Attachment: ${lastMessage.file?.name || "file"}`
                        : lastMessage.content,
                    createdAt: lastMessage.createdAt,
                    sender: lastMessage.sender,
                    type: lastMessage.type,
                    file: lastMessage.file
                }
                : null,
            unreadCount: 0,
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const createConversation = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const { recipientId, isGroup, name, participantIds } = req.body;

        if (isGroup) {
            const normalizedName = String(name || "").trim();
            const rawParticipants = Array.isArray(participantIds) ? participantIds : [];

            const normalizedIds = [...new Set([
                ...rawParticipants.map((id) => String(id || "").trim()).filter(Boolean),
                String(currentUser._id)
            ])];

            const allIdsValid = normalizedIds.every((id) => mongoose.Types.ObjectId.isValid(id));
            if (!normalizedName) {
                return res.status(httpStatus.BAD_REQUEST).json({ message: "Group name is required" });
            }
            if (!allIdsValid || normalizedIds.length < 3) {
                return res.status(httpStatus.BAD_REQUEST).json({ message: "At least 3 valid members are required for a group" });
            }

            const members = await User.find(
                { _id: { $in: normalizedIds } },
                { _id: 1, name: 1, username: 1, bio: 1, avatarUrl: 1 }
            ).lean();

            if (members.length !== normalizedIds.length) {
                return res.status(httpStatus.BAD_REQUEST).json({ message: "Some selected users were not found" });
            }

            const createdGroup = await Group.create({
                name: normalizedName,
                members: normalizedIds,
                createdBy: currentUser._id,
            });

            return res.status(httpStatus.CREATED).json({
                _id: `grp-${createdGroup._id}`,
                name: createdGroup.name,
                isGroup: true,
                participants: members.map(toPublicUser),
                unreadCount: 0,
                lastMessage: null,
            });
        }

        if (!recipientId || !mongoose.Types.ObjectId.isValid(recipientId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid recipient id" });
        }

        const peer = await User.findById(recipientId, { name: 1, username: 1, bio: 1, avatarUrl: 1 }).lean();
        if (!peer) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Recipient not found" });
        }

        const isFriend = await areUsersFriends(currentUser._id, peer._id);
        if (!isFriend) {
            return res.status(httpStatus.FORBIDDEN).json({ message: "Add this user as a friend to start chatting" });
        }

        return res.status(httpStatus.CREATED).json({
            _id: `dm-${peer._id}`,
            isGroup: false,
            participants: [
                toPublicUser(currentUser),
                toPublicUser(peer)
            ],
            unreadCount: 0,
            lastMessage: null,
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const getConversationMessages = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const peerId = req.params.userId;
        if (!peerId || !mongoose.Types.ObjectId.isValid(peerId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid user id" });
        }

        const isFriend = await areUsersFriends(currentUser._id, peerId);
        if (!isFriend) {
            return res.status(httpStatus.FORBIDDEN).json({ message: "Add this user as a friend to start chatting" });
        }

        const page = Math.max(1, parseInt(req.query.page || "1", 10));
        const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || "30", 10)));
        const skip = (page - 1) * limit;

        const messages = await Message.find({
            $or: [
                { sender: currentUser._id, recipient: peerId },
                { sender: peerId, recipient: currentUser._id }
            ]
        })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate("sender", "_id name username")
            .lean();

        const ordered = [...messages].reverse().map((m) => ({
            _id: m._id,
            content: m.content,
            type: m.type,
            file: m.file,
            createdAt: m.createdAt,
            sender: m.sender,
            senderId: m.sender?._id
        }));

        return res.status(httpStatus.OK).json({ messages: ordered });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const sendMessage = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const { recipientId, content } = req.body;
        const uploadedFile = req.file;
        if (!recipientId || !mongoose.Types.ObjectId.isValid(recipientId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid recipient id" });
        }

        const normalizedContent = String(content || "").trim();
        if (!normalizedContent && !uploadedFile) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Message content or file is required" });
        }

        const peer = await User.findById(recipientId);
        if (!peer) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Recipient not found" });
        }

        const isFriend = await areUsersFriends(currentUser._id, recipientId);
        if (!isFriend) {
            return res.status(httpStatus.FORBIDDEN).json({ message: "Add this user as a friend to start chatting" });
        }

        const fileUrl = uploadedFile
            ? `${req.protocol}://${req.get("host")}/uploads/${uploadedFile.filename}`
            : null;

        const created = await Message.create({
            sender: currentUser._id,
            recipient: recipientId,
            content: normalizedContent,
            type: uploadedFile ? "file" : "text",
            file: uploadedFile
                ? {
                    name: uploadedFile.originalname,
                    mimeType: uploadedFile.mimetype,
                    size: uploadedFile.size,
                    url: fileUrl
                }
                : undefined
        });

        const populated = await Message.findById(created._id)
            .populate("sender", "_id name username")
            .lean();

        return res.status(httpStatus.CREATED).json({
            _id: populated._id,
            content: populated.content,
            type: populated.type,
            file: populated.file,
            createdAt: populated.createdAt,
            sender: populated.sender,
            senderId: populated.sender?._id,
            conversationId: `dm-${recipientId}`
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const deleteMessage = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const messageId = req.params.id;
        if (!messageId || !mongoose.Types.ObjectId.isValid(messageId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid message id" });
        }

        const deleted = await Message.findOneAndDelete({
            _id: messageId,
            sender: currentUser._id
        });

        if (!deleted) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Message not found" });
        }

        return res.status(httpStatus.OK).json({ message: "Message deleted" });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};


const register = async (req, res) => {
    const { name, username, password } = req.body;


    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(httpStatus.FOUND).json({ message: "User already exists" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = new User({
            name: name,
            username: username,
            password: hashedPassword
        });

        await newUser.save();

        res.status(httpStatus.CREATED).json({ message: "User Registered" })

    } catch (e) {
        res.json({ message: `Something went wrong ${e}` })
    }

}


const getUserHistory = async (req, res) => {
    const { token } = req.query;

    try {
        const user = await User.findOne({ token: token });
        const meetings = await Meeting.find({ user_id: user.username })
        res.json(meetings)
    } catch (e) {
        res.json({ message: `Something went wrong ${e}` })
    }
}

const addToHistory = async (req, res) => {
    const { token, meeting_code } = req.body;

    try {
        const user = await User.findOne({ token: token });

        const newMeeting = new Meeting({
            user_id: user.username,
            meetingCode: meeting_code
        })

        await newMeeting.save();

        res.status(httpStatus.CREATED).json({ message: "Added code to history" })
    } catch (e) {
        res.json({ message: `Something went wrong ${e}` })
    }
}

const getProfile = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        return res.status(httpStatus.OK).json({
            _id: currentUser._id,
            name: currentUser.name,
            username: currentUser.username,
            bio: currentUser.bio || "",
            avatarUrl: currentUser.avatarUrl || ""
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
}

const updateProfile = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const nextName = String(req.body.name || "").trim();
        const nextBio = String(req.body.bio || "").trim();

        if (nextName) {
            currentUser.name = nextName;
        }

        currentUser.bio = nextBio;

        if (req.file) {
            currentUser.avatarUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;
        }

        await currentUser.save();

        return res.status(httpStatus.OK).json({
            _id: currentUser._id,
            name: currentUser.name,
            username: currentUser.username,
            bio: currentUser.bio || "",
            avatarUrl: currentUser.avatarUrl || ""
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
}

const createFriendRequest = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const targetUserId = String(req.body.userId || "").trim();
        if (!targetUserId || !mongoose.Types.ObjectId.isValid(targetUserId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid user id" });
        }

        if (String(currentUser._id) === targetUserId) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "You cannot send a friend request to yourself" });
        }

        const targetUser = await User.findById(targetUserId, { _id: 1 }).lean();
        if (!targetUser) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "User not found" });
        }

        const isFriend = await areUsersFriends(currentUser._id, targetUserId);
        if (isFriend) {
            return res.status(httpStatus.CONFLICT).json({ message: "User is already your friend" });
        }

        const incomingPending = await FriendRequest.findOne({
            from: targetUserId,
            to: currentUser._id,
            status: "pending"
        }).lean();

        if (incomingPending) {
            return res.status(httpStatus.CONFLICT).json({ message: "This user already sent you a friend request" });
        }

        let outgoingRequest = await FriendRequest.findOne({ from: currentUser._id, to: targetUserId });

        if (outgoingRequest?.status === "pending") {
            return res.status(httpStatus.OK).json({
                message: "Friend request already sent",
                requestId: outgoingRequest._id,
                status: outgoingRequest.status,
            });
        }

        if (!outgoingRequest) {
            outgoingRequest = await FriendRequest.create({
                from: currentUser._id,
                to: targetUserId,
                status: "pending",
            });
        } else {
            outgoingRequest.status = "pending";
            await outgoingRequest.save();
        }

        return res.status(httpStatus.CREATED).json({
            message: "Friend request sent",
            requestId: outgoingRequest._id,
            status: outgoingRequest.status,
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const acceptFriendRequest = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const fromUserId = String(req.body.userId || "").trim();
        if (!fromUserId || !mongoose.Types.ObjectId.isValid(fromUserId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid user id" });
        }

        const request = await FriendRequest.findOne({
            from: fromUserId,
            to: currentUser._id,
            status: "pending"
        });

        if (!request) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Friend request not found" });
        }

        request.status = "accepted";
        await request.save();

        await User.updateOne({ _id: currentUser._id }, { $addToSet: { friends: fromUserId } });
        await User.updateOne({ _id: fromUserId }, { $addToSet: { friends: currentUser._id } });

        return res.status(httpStatus.OK).json({ message: "Friend request accepted" });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const rejectFriendRequest = async (req, res) => {
    try {
        const currentUser = await getCurrentUserFromRequest(req);
        if (!currentUser) {
            return res.status(httpStatus.UNAUTHORIZED).json({ message: "Unauthorized" });
        }

        const fromUserId = String(req.body.userId || "").trim();
        if (!fromUserId || !mongoose.Types.ObjectId.isValid(fromUserId)) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Invalid user id" });
        }

        const request = await FriendRequest.findOne({
            from: fromUserId,
            to: currentUser._id,
            status: "pending"
        });

        if (!request) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Friend request not found" });
        }

        request.status = "rejected";
        await request.save();

        return res.status(httpStatus.OK).json({ message: "Friend request rejected" });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

export {
    login,
    register,
    getUserHistory,
    addToHistory,
    getAllUsers,
    getContacts,
    createFriendRequest,
    acceptFriendRequest,
    rejectFriendRequest,
    getAllConversations,
    getConversationById,
    createConversation,
    getConversationMessages,
    sendMessage,
    deleteMessage,
    getProfile,
    updateProfile,
    requestPasswordReset,
    resetPassword
}

const requestPasswordReset = async (req, res) => {
    const { username } = req.body;

    if (!username) {
        return res.status(httpStatus.BAD_REQUEST).json({ message: "Username is required" });
    }

    try {
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "User Not Found" });
        }

        const resetToken = crypto.randomBytes(4).toString("hex").toUpperCase();
        user.resetToken = resetToken;
        user.resetTokenExpires = new Date(Date.now() + 15 * 60 * 1000);
        await user.save();

        return res.status(httpStatus.OK).json({
            message: "Reset code generated",
            resetToken
        });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};

const resetPassword = async (req, res) => {
    const { username, resetToken, newPassword } = req.body;

    if (!username || !resetToken || !newPassword) {
        return res.status(httpStatus.BAD_REQUEST).json({ message: "Username, reset code, and new password are required" });
    }

    try {
        const user = await User.findOne({ username, resetToken });
        if (!user) {
            return res.status(httpStatus.NOT_FOUND).json({ message: "Invalid username or reset code" });
        }

        if (!user.resetTokenExpires || user.resetTokenExpires.getTime() < Date.now()) {
            return res.status(httpStatus.BAD_REQUEST).json({ message: "Reset code expired" });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.resetToken = undefined;
        user.resetTokenExpires = undefined;
        user.token = undefined;
        await user.save();

        return res.status(httpStatus.OK).json({ message: "Password updated successfully" });
    } catch (e) {
        return res.status(httpStatus.INTERNAL_SERVER_ERROR).json({ message: `Something went wrong ${e}` });
    }
};