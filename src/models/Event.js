import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";

// B15: the "Event" table is the school's post table (news, events, polls).
// It keeps the old name and columns so the old /news, /events, /add-news ...
// calls and the MySQL -> Postgres move keep working (migration 037):
//   name = post title, description = body, date = event (start) date,
//   time = free-text event time.
// imageKey is internal: it is never sent to the browser.
const event = sequelize.define('event', {
    eventId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'event_id'
    },
    name: {
      type: DataTypes.STRING(255), // the app allows 150 (posts.js); live MySQL has 255
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    time: {
      type: DataTypes.STRING,
      allowNull: true
    },
    created_at: {
      type: DataTypes.STRING,
      allowNull: true
    },
    postType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "NEWS", field: "post_type" },
    status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "PUBLISHED", field: "status" },
    isPinned: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_pinned" },
    audience: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "ALL", field: "audience" },
    audienceClassIds: { type: DataTypes.ARRAY(DataTypes.INTEGER), allowNull: true, field: "audience_class_ids" },
    commentsEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true, field: "comments_enabled" },
    imageKey: { type: DataTypes.STRING(120), allowNull: true, field: "image_key" },
    eventEndDate: { type: DataTypes.DATEONLY, allowNull: true, field: "event_end_date" },
    location: { type: DataTypes.STRING(200), allowNull: true, field: "location" },
    pollClosesAt: { type: DataTypes.DATE, allowNull: true, field: "poll_closes_at" },
    createdBy: { type: DataTypes.STRING(100), allowNull: true, field: "created_by" },
    publishedAt: { type: DataTypes.DATE, allowNull: true, field: "published_at" },
    updatedAt: { type: DataTypes.DATE, allowNull: true, field: "updated_at" },
  }, {
    sequelize,
    tableName: 'Event',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Event__2370F727B3E0221E",
        unique: true,
        fields: [
          { name: "event_id" },
        ]
      },
      { name: "idx_event_feed", fields: ["status", "is_pinned", "published_at"] },
      { name: "idx_event_date", fields: ["date"] },
    ]
  });


export default event
