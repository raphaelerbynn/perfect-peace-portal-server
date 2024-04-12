import { Allowance, Deductions, EmployeeSalary, Salary, SalaryPayment, Teacher } from "../models/index.js";


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
    return await SalaryPayment.findAll();
  } else {
    const startDate = new Date(data.dateStart).toISOString();
    const endDate = new Date(data.dateEnd).toISOString();
    return await SalaryPayment.findAll({
      where: {
        datePaid: {
          [Op.gte]: literal(`CONVERT(DATE, '${startDate}', 126)`),
          [Op.lte]: literal(`CONVERT(DATE, '${endDate}', 126)`),
        },
      },
    });
  }
}

const getEmployeeSalary = async () => {
    const response = await EmployeeSalary.findAll();
    return response;
}

const createSalaryPayment = async (data) => {
    const response = await SalaryPayment.create({
        name: data?.name,
        amount: data?.amount,
        net: data?.net,
        salaryDate: data?.salaryDate,
        paymentMethod: data?.paymentMethod,
        datePaid: Date.now(),
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

    removeSalary,
    removeDeductions,
    removeAllowance,
    removeSalaryPayment,

    _assignSalary
}