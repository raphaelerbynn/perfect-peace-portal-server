import { literal, Op } from "sequelize";
import { Allowance, Deductions, EmployeeSalary, Salary, SalaryPayment, Teacher } from "../models/index.js";
import { sendSMSMessage } from "./messaging.js";
import { composeMessage } from "../utils/func.js";
import { payroll_template } from "../utils/messageTemplates.js";


const getSalary = async () => {
    const response = await Salary.findAll();
    return response;
}

const getDeductions = async (salary_id) => {
    const response = await Deductions.findAll({
        where: {
            salaryId: salary_id,
        },
    });
    return response;
}

const getAllowance = async (salary_id) => {
    const response = await Allowance.findAll({
        where: {
            salaryId: salary_id,
        },
    });
    return response;
}

const getOneSalary = async (id) => {
    const response = await Salary.findAll({
        where: {
            salaryId: id
        }
    });
    return response;
}

const getOneDeduction = async (id) => {
    const response = await Deductions.findAll({
        where: {
            salaryId: id
        }
    });
    return response;
}

const getOneAllowance = async (id) => {
    const response = await Allowance.findAll({
        where: {
            salaryId: id
        }
    });
    return response;
}

const getSalaryPayment = async (data) => {
    
  if (data.all === "true") {
    return await SalaryPayment.findAll({
      order: [['datePaid', 'DESC']],
    });
  } 
  else if (data.query) {
    console.log(data)
      const teachers = await Teacher.findAll({
        where: {
          [Op.or]: [
            { fName: { [Op.like]: `%${data.query}%` } },
            { lName: { [Op.like]: `%${data.query}%` } }
          ],
        },
      });
      const teacherIds = teachers.map((teacher) => teacher.teacherId);
      return await SalaryPayment.findAll({
        where: {
          teacherId: teacherIds,
        },
        order: [['datePaid', 'DESC']],
      });
  }
  else {
    let startDate;
    let endDate;
    if (data.dateStart && data.dateEnd) {
      startDate = new Date(data.dateStart).toISOString();
      endDate = new Date(data.dateEnd).toISOString();
    } else {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate = firstDayOfMonth.toISOString();
      endDate = now.toISOString();
    }
    return await SalaryPayment.findAll({
      where: {
        datePaid: {
          [Op.gte]: new Date(startDate),
          [Op.lte]: new Date(endDate),
        },
      },
      order: [['datePaid', 'DESC']],
    });
  }
}

const getEmployeeSalary = async () => {
    const response = await EmployeeSalary.findAll();
    return response;
}

const createSalaryPayment = async (data) => {
    const teacherData = await Teacher.findOne({
        where: {
            teacherId: data?.teacherId
        }
    })
    if (teacherData?.phone) {
        await sendSMSMessage(
            composeMessage({...data, name: `${teacherData?.fName} ${teacherData?.lName}`}, payroll_template), 
            [teacherData?.phone]
        )
    }

    const response = await SalaryPayment.create({
        teacherId: data?.teacherId,
        amount: data?.amount,
        salaryId: data?.salaryId,
        term: data?.term,
        salaryDate: data?.salaryDate,
        paymentMethod: data?.paymentMethod,
        amountInWords: data?.amountInWords,
        datePaid: Date.now(),
    },
    {
        raw: true
    });

    return response;
}

const createSalary = async (data) => {
    const response = await Salary.create({
        title: data?.title,
        rank: data?.rank,
        amount: data?.amount
    })

    return response;
}

const editSalary = (data, id) => {
    return Salary.update(data, {
        where: {
            salaryId: id
        },
        raw: true
    });
}

const createDeduction = async (data) => {
    const response = await Deductions.create({
        salaryId: data?.salaryId,
        title: data?.title,
        amount: data?.amount
    })

    return response;
}

const createAllowance = async (data) => {
    const response = await Allowance.create({
        salaryId: data?.salaryId,
        title: data?.title,
        amount: data?.amount
    });

    return response;
}

const removeSalary = async (id) => {
    const teacher = await Teacher.update(
        {
            salaryId: null
        },
        {
            where: {
                salaryId: id
            }
        }
    );
    // console.log(teacher);

    const response = await Salary.destroy({
        where: {
            salaryId: id
        }
    });
    return response
}

const removeDeductions = async (id) => {
    const response = await Deductions.destroy({
        where: {
            salaryId: id
        }
    });
    return response
}

const removeAllowance = async (id) => {
    const response = await Allowance.destroy({
        where: {
            salaryId: id
        }
    });
    return response
}

const removeSalaryPayment = async (id) => {
    const response = await SalaryPayment.destroy({
        where: {
            salaryPaymentId: id
        }
    });
    return response
}

const _assignSalary = async (data) => {
    const response = await EmployeeSalary.create({
        teacherId: data?.teacherId,
        salaryId: data?.salaryId
    })

    return response;
}

export {
    getSalary,
    getDeductions,
    getAllowance,
    getOneSalary,
    getOneDeduction,
    getOneAllowance,
    getSalaryPayment,
    getEmployeeSalary,

    createSalaryPayment,
    createSalary,
    createDeduction,
    createAllowance,

    editSalary,

    removeSalary,
    removeDeductions,
    removeAllowance,
    removeSalaryPayment,

    _assignSalary
}