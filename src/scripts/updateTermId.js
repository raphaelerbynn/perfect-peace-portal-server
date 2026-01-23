import sequelize from "../config/database.js";
import { StudentMarks, StudentResult, KgAssessment } from "../models/index.js";
import moment from "moment";
import { Op } from "sequelize";



const updateTermIds = async () => {
  const startDate = moment("2025-01-01").startOf('day');
  const endDate = moment("2025-01-20").endOf('day');
  
  try {
    await sequelize.transaction(async (t) => {
      // Update StudentMarks
      await StudentMarks.update(
        { termId: 5 },
        {
          where: {
            // student_marks_id: 17658,
            date: {
              [Op.between]: [startDate, endDate]
            }
          },
          transaction: t
        }
      );

      // Update StudentResult
      await StudentResult.update(
        { termId: 5 },
        {
          where: {
            date: {
              [Op.between]: [startDate, endDate]
            }
          },
          transaction: t
        }
      );

      // Update KgAssessment
      await KgAssessment.update(
        { termId: 5 },
        {
          where: {
            date: {
              [Op.between]: [startDate, endDate]
            }
          },
          transaction: t
        }
      );
    });

    console.log('Successfully updated termIds to 6 for the specified date range');
  } catch (error) {
    console.error('Error updating termIds:', error);
    throw error;
  }
};

// Execute the update
updateTermIds()
  .then(() => {
    console.log('Update completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Update failed:', error);
    process.exit(1);
  });