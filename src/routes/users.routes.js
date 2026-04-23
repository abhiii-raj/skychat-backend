import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import {
	addToHistory,
	createConversation,
	deleteMessage,
	getAllConversations,
	getAllUsers,
	getContacts,
	createFriendRequest,
	acceptFriendRequest,
	rejectFriendRequest,
	getConversationById,
	getConversationMessages,
	getProfile,
	getUserHistory,
	login,
	register,
	sendMessage,
	requestPasswordReset,
	resetPassword,
	updateProfile
} from "../controllers/user.controller.js";



const router = Router();
const uploadsDir = path.resolve(process.cwd(), "uploads");

if (!fs.existsSync(uploadsDir)) {
	fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
	destination: (_req, _file, cb) => cb(null, uploadsDir),
	filename: (_req, file, cb) => {
		const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
		cb(null, `${Date.now()}-${safe}`);
	}
});

const upload = multer({ storage });

router.route("/login").post(login)
router.route("/register").post(register)
router.route("/forgot-password").post(requestPasswordReset)
router.route("/reset-password").post(resetPassword)
router.route("/profile").get(getProfile).put(upload.single("avatar"), updateProfile)
router.route("/users").get(getAllUsers)
router.route("/contacts").get(getContacts)
router.route("/friends/request").post(createFriendRequest)
router.route("/friends/accept").post(acceptFriendRequest)
router.route("/friends/reject").post(rejectFriendRequest)
router.route("/conversations").get(getAllConversations).post(createConversation)
router.route("/conversations/:id").get(getConversationById)
router.route("/messages/:userId").get(getConversationMessages)
router.route("/messages").post(upload.single("file"), sendMessage)
router.route("/messages/:id").delete(deleteMessage)
router.route("/add_to_activity").post(addToHistory)
router.route("/get_all_activity").get(getUserHistory)

export default router;