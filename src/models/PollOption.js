import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B15: a choice on a POLL post (migration 037).
const PollOption = sequelize.define(
  "pollOption",
  {
    optionId: { autoIncrement: true, type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "option_id" },
    postId: { type: DataTypes.INTEGER, allowNull: false, field: "post_id" },
    label: { type: DataTypes.STRING(200), allowNull: false, field: "label" },
    position: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "position" },
  },
  {
    sequelize,
    tableName: "Poll_option",
    schema: "dbo",
    timestamps: false,
    indexes: [{ name: "idx_poll_option_post", fields: ["post_id", "position"] }],
  }
);

export default PollOption;
