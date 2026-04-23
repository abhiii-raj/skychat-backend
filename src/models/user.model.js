import mongoose, { Schema } from "mongoose";

const userScheme = new Schema(
    {
        name: { type: String, required: true },
        username: { type: String, required: true, unique: true },
        password: { type: String, required: true },
        token: { type: String },
        resetToken: { type: String },
        resetTokenExpires: { type: Date },
        bio: { type: String, default: "" },
        avatarUrl: { type: String, default: "" },
        friends: [{ type: Schema.Types.ObjectId, ref: "User", default: [] }]
    }
)

const User = mongoose.model("User", userScheme);

export { User };