import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// AI-4 (migration 049): what people and the AI added to one pupil's watchlist
// entry for one term. Who is on the watchlist is computed on every read
// (services/atRisk); a row exists only once someone acted on the entry.
// status: null = open, HANDLING, DISMISSED. ai_* = the AI's note, shown only
// while ai_fingerprint matches the pupil's current reasons and figures.
const AiWatchlistEntry = sequelize.define(
  "aiWatchlistEntry",
  {
    studentId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "student_id" },
    termId: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, field: "term_id" },
    status: { type: DataTypes.STRING(10), allowNull: true, field: "status" },
    statusNote: { type: DataTypes.STRING(300), allowNull: true, field: "status_note" },
    statusKinds: { type: DataTypes.JSONB, allowNull: true, field: "status_kinds" },
    statusBy: { type: DataTypes.STRING(110), allowNull: true, field: "status_by" },
    statusAt: { type: DataTypes.DATE, allowNull: true, field: "status_at" },
    aiNote: { type: DataTypes.STRING(600), allowNull: true, field: "ai_note" },
    aiNextStep: { type: DataTypes.STRING(400), allowNull: true, field: "ai_next_step" },
    aiFingerprint: { type: DataTypes.STRING(16), allowNull: true, field: "ai_fingerprint" },
    aiModel: { type: DataTypes.STRING(60), allowNull: true, field: "ai_model" },
    aiPromptVersion: { type: DataTypes.STRING(60), allowNull: true, field: "ai_prompt_version" },
    aiWrittenBy: { type: DataTypes.STRING(110), allowNull: true, field: "ai_written_by" },
    aiWrittenAt: { type: DataTypes.DATE, allowNull: true, field: "ai_written_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: "updated_at" },
  },
  { sequelize, tableName: "Ai_watchlist_entry", schema: "dbo", timestamps: false }
);

export default AiWatchlistEntry;
