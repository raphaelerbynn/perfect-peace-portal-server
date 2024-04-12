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
    name: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    amount: {
      type: DataTypes.STRING(15),
      allowNull: true
    },
    net: {
      type: DataTypes.STRING(15),
      allowNull: true
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
    datePaid: {
      type: DataTypes.DATEONLY,
      allowNull: true,
      field: 'date_paid'
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


export default _