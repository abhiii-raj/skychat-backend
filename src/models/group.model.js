import mongoose, { Schema } from "mongoose";

const groupSchema = new Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 80 },
        members: [{ type: Schema.Types.ObjectId, ref: "User", required: true }],
        createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    },
    { timestamps: true }
);

const Group = mongoose.models.Group || mongoose.model("Group", groupSchema);

export { Group };
