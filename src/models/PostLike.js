import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B15: one like per post per actor (migration 037). actorType STUDENT | STAFF | OFFICE.
const PostLike = sequelize.define(
  "postLike",
  {
    likeId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "like_id" },
    postId: { type: DataTypes.INTEGER, allowNull: false, field: "post_id" },
    actorType: { type: DataTypes.STRING(10), allowNull: false, field: "actor_type" },
    actorId: { type: DataTypes.STRING(100), allowNull: false, field: "actor_id" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Post_like",
    schema: "dbo",
    timestamps: false,
    indexes: [{ name: "uniq_post_like", unique: true, fields: ["post_id", "actor_type", "actor_id"] }],
  }
);

export default PostLike;
