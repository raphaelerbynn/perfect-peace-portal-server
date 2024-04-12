import { Class, Fee, FeeCheck, Student } from "../models/index.js";
import { Op, literal } from "sequelize";

const createFee = async (data) => {
  const response = await Fee.create({
    studentId: data?.studentId, 
    classId: data?.classId, 
    total: data?.total,
    paid: data?.currentPaid,
    remaining: data?.remaining,
    paymentMode: data?.paymentMode,
    amountInWords: data?.amountInWords,
    datePaid: data?.datePaid,
    term: data?.term,
  });

  //update student data
  const updateStudent = await Student.update(
    {
      feesPaid: data?.totalPaid,
      feesOwing: data?.remaining
    },
    {
      where: {
        student_id: data?.studentId,
      },
    }
  )

  // console.log(updateStudent)

  return response;
}

const removeFee = async (id) => {
  const response = await Fee.destroy({
    where: {
      feeId: id
    }
  })

  return response;
}

const getOneFee = async (id) => {
  const response = await Fee.findOne({
    where: {
      feeId: id
    }
  })
  return response;
}

const getFeesData = async (data) => {
  console.log(data)
  if (data.all === "true") {
    return await Fee.findAll();
  } else {
    const startDate = new Date(data.startDate).toISOString();
    const endDate = new Date(data.endDate).toISOString();
    return await Fee.findAll({
      where: {
        datePaid: {
          [Op.gte]: literal(`DATE_FORMAT('${startDate}', '%Y-%m-%d')`),
          [Op.lte]: literal(`DATE_FORMAT('${endDate}', '%Y-%m-%d')`),
        },
      },
    });
  } 
};

const getFeeCheck = async () => {
  return await FeeCheck.findAll({
    attributes: ["value"],
  });
};

const getFeeList = async (indexNumber) => {
  const student = await Student.findOne({
    where: {
      student_id: indexNumber,
    },
    attributes: ["class"],
  });

  if (student) {
    const studentClass = student.class;

    const classDetails = await Class.findOne({
      where: {
        name: studentClass,
      },
    });

    return classDetails;
  } else {
    return null;
  }
};

export { createFee, removeFee, getFeeCheck, getFeeList, getFeesData, getOneFee };
