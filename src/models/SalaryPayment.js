import sequelize from "../config/database.js";
import { DataTypes } from "sequelize";


const _ = sequelize.define('salaryPayment', {
    salaryPaymentId: {
      autoIncrement: true,
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      field: 'salary_payment_id'
    },
    teacherId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Teacher',
        key: 'teacher_id'
      },
      onDelete: 'SET NULL',
      field: 'teacher_id'
    },
    amount: {
      type: DataTypes.STRING(15),
      allowNull: true
    },
    salaryId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Salary',
        key: 'salary_id'
      },
      onDelete: 'SET NULL',
      field: 'salary_id'
    },
    salaryDate: {
      type: DataTypes.STRING(15),
      allowNull: true,
      field: 'salary_date'
    },
    paymentMethod: {
      type: DataTypes.STRING(50),
      allowNull: true,
      field: 'payment_method'
    },
    amountInWords: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'amount_in_words'
    },
    datePaid: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_paid'
    },
    term: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'Term',
        key: 'term_id'
      },
      field: 'term'
    }
  }, {
    sequelize,
    tableName: 'Salary_payment',
    schema: 'dbo',
    timestamps: false,
    indexes: [
      {
        name: "PK__Salary_p__C9967DDC01636AE9",
        unique: true,
        fields: [
          { name: "salary_payment_id" },
        ]
      },
    ]
  });

  // _.sync()

export default _