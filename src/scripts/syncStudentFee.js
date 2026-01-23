import sequelize from "../config/database.js";
import StudentFee from "../models/StudentFee.js";

(async () => {
  try {
    await sequelize.authenticate();
    console.log("Database connection OK");

    // This will create the StudentFee table if it doesn't exist, and alter it to match the model if necessary.
    await StudentFee.sync({ alter: true });
    console.log("StudentFee table synced (created/altered)");
    process.exit(0);
  } catch (err) {
    console.error("Error syncing StudentFee table:", err);
    process.exit(1);
  }
})();
