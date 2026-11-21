import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B15: one vote per poll per actor (migration 037, uniq_poll_vote_voter).
const PollVote = sequelize.define(
  "pollVote",
  {
    voteId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "vote_id" },
    postId: { type: DataTypes.INTEGER, allowNull: false, field: "post_id" },
    optionId: { type: DataTypes.INTEGER, allowNull: false, field: "option_id" },
    actorType: { type: DataTypes.STRING(10), allowNull: false, field: "actor_type" },
    actorId: { type: DataTypes.STRING(100), allowNull: false, field: "actor_id" },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "created_at" },
  },
  {
    sequelize,
    tableName: "Poll_vote",
    schema: "dbo",
    timestamps: false,
    indexes: [
      { name: "uniq_poll_vote_voter", unique: true, fields: ["post_id", "actor_type", "actor_id"] },
      { name: "idx_poll_vote_option", fields: ["option_id"] },
    ],
  }
);

export default PollVote;
