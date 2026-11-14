import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B15: a comment on a post (migration 037). status VISIBLE | HIDDEN (an
// Administrator hides it). actorName is the author's name when it was written.
const PostComment = sequelize.define(
  "postComment",
  {
    commentId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "comment_id" },
    postId: { type: DataTypes.INTEGER, allowNull: false, field: "post_id" },
    actorType: { type: DataTypes.STRING(10), allowNull: false, field: "actor_type" },
    actorId: { type: DataTypes.STRING(100), allowNull: false, field: "actor_id" },
    actorName: { type: DataTypes.STRING(120), allowNull: true, field: "actor_name" },
    body: { type: DataTypes.STRING(1000), allowNull: false, field: "body" },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "VISIBLE", field: "status" },
    hiddenBy: { type: DataTypes.STRING(100), allowNull: true, field: "hidden_by" },
    hiddenAt: { type: DataTypes.DATE, allowNull: true, field: "hidden_at" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Post_comment",
    schema: "dbo",
    timestamps: false,
    indexes: [{ name: "idx_post_comment_post", fields: ["post_id", "created_at"] }],
  }
);

export default PostComment;
