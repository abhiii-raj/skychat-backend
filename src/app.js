import express from "express";
import { createServer } from "node:http";
import path from "node:path";

import { Server } from "socket.io";
import "dotenv/config";

import mongoose from "mongoose";
import { connectToSocket } from "./controllers/socketManager.js";

import cors from "cors";
import userRoutes from "./routes/users.routes.js";

const app = express();
const server = createServer(app);
const io = connectToSocket(server);


app.set("port", (process.env.PORT || 8000))
app.use(cors());
app.use(express.json({ limit: "40kb" }));
app.use(express.urlencoded({ limit: "40kb", extended: true }));
app.use("/uploads", express.static(path.resolve(process.cwd(), "uploads")));

app.use("/api/v1/users", userRoutes);

server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
        console.error(`PORT ${app.get("port")} is already in use.`);
        console.error("Stop the existing process using this port, or set a different PORT in backend/.env.");
        process.exit(1);
    }

    console.error("Server failed to start:", error);
    process.exit(1);
});

const start = async () => {
    const mongoUrl = process.env.MONGODB_URL;
    if (!mongoUrl) {
        throw new Error("MONGODB_URL is not set. Add it to backend/.env");
    }

    const connectionDb = await mongoose.connect(mongoUrl);

    console.log(`MONGO Connected DB Host: ${connectionDb.connection.host}`);
    server.listen(app.get("port"), () => {
        console.log(`LISTENING ON PORT ${app.get("port")}`);
    });
}



start().catch((error) => {
    console.error("Startup failed:", error);
    process.exit(1);
});