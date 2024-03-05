import { createFeeding, createBusFee, createExtraClasses, getBusFee, getExtraClasses, getFeeding, removeBusFee, removeExtraClasses, removeFeeding } from "../services/account.js";
import { createClassAttendance, removeAttendance, getAttendance } from "../services/attendance.js";
import { createClass, createClassFee, editClass, editClassFee, removeClass, removeClassFee } from "../services/classes.js";
import { createFee, getFeesData, getOneFee, removeFee } from "../services/fee.js";
import { getNews } from "../services/news.js";
import { _assignSalary, createAllowance, createDeduction, createSalary, createSalaryPayment, getAllowance, getDeductions, getEmployeeSalary, getOneAllowance, getOneDeduction, getOneSalary, getSalary, getSalaryPayment, removeAllowance, removeDeductions, removeSalary, removeSalaryPayment } from "../services/payroll.js";
import {
  getStudentContact,
  getTeacherContact,
  sendResetPin,
} from "../services/resetPin.js";
import {
  createMarksResult,
  createResult,
  getClassMarks,
  getClassResult,
  getOneStudentMarks,
  getOneStudentResult,
  removeResult,
} from "../services/results.js";
import {
  createStaff,
  editStaff,
  getStaff,
  removeStaff,
} from "../services/staff.js";
import { createSubject, removeSubject } from "../services/subject.js";
import { getTerm } from "../services/term.js";
import {
  createStudent,
  editStudent,
  getStudents,
  removeStudent,
} from "../services/test.js";
import {
  changeStudentPassword,
  changeTeacherPassword,
  getStudentDetails,
  getTeacherDetails,
} from "../services/user.js";

// management
const fetchAllStudents = async (req, res, next) => {
  try {
    const data = await getStudents();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchAllStaff = async (req, res, next) => {
  try {
    const data = await getStaff();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchClassMarks = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getClassMarks(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

//not complete
const fetchAttendance = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getAttendance(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchFees = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getFeesData(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchOneFee = async (req, res, next) => {
  const id = req.params.fee_id;
  try {
    const data = await getOneFee(id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchClassResult = async (req, res, next) => {
  const values = req.query;
  try {
    const results = await getClassResult(values);
    const marks = await getClassMarks(values);

    const data = results.map((result) => {
        const { studentId } = result.dataValues;
        const studentMarks = marks.filter((mark) => {
            if (mark.studentId === studentId) {
              return mark;
            }
        });

        return {
        ...result.dataValues,
          marks: studentMarks,
        };
    })

    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchOneStudentResult = async (req, res, next) => {
  const values = req.query;
  try {
    const result = await getOneStudentResult(values);
    const marks = await getOneStudentMarks(values);

        // const { studentId } = result.dataValues;
        // const studentMarks = marks.filter((mark) => {
        //     if (mark.studentId === studentId) {
        //       return mark;
        //     }
        // });

        // return {
        // ...result.dataValues,
        //   marks: studentMarks,
        // };

    res.json({
      ...result[0]?.dataValues,
      marks: marks,
    });
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchFeeding = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getFeeding(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

const fetchExtraClasses = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getExtraClasses(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

const fetchBusFee = async (req, res, next) => {
  const values = req.query;
  try {
    const data = await getBusFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

const fetchSalary = async (req, res, next) => {
  try {
    const salaries = await getSalary();

    const data = await Promise.all(
      salaries?.map(async (salary, index) => {
        let amount = salary?.dataValues?.amount;
        let grossAmount = 0;
        let netAmount = 0;

        const allowancesData = await getAllowance(salary?.dataValues?.salaryId);
        const allowances = allowancesData ? allowancesData.reduce((acc, curr) => acc + Number(curr.dataValues.amount), 0) : 0;
        
        const deductionsData = await getDeductions(salary?.dataValues?.salaryId);
        const deductions = deductionsData ? deductionsData.reduce((acc, curr) => acc + Number(curr.dataValues.amount), 0) : 0;
        
        grossAmount = Number(amount) + Number(allowances);
        netAmount = grossAmount + Number(deductions);
        return {
          ...salary.dataValues,
          netAmount: netAmount,
          grossAmount: grossAmount, // Optionally, format the result to two decimal places
        };
      })
    );
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

//dont use
const fetchDeductions = async (req, res, next) => {
  try {
    const data = await getDeductions();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

//dont use
const fetchAllowances = async (req, res, next) => {
  try {
    const data = await getAllowance();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
}

const fetchOneSalary = async (req, res, next) => {
  const id = req.params.salary_id;
  try {
    const salary = await getOneSalary(id);
    const deductions = await getOneDeduction(id);
    const allowances = await getOneAllowance(id);

    const data = {
      salary,
      deductions,
      allowances,
    }
    res.json(data);
  } catch (error) {
    next(error)
  }
}

const fetchSalaryPayment = async (req, res, next) => {
  const values = req.query;
  try {
    //sample  values
    // const values = {
    //   dateStart: '2022-09-26',
    //   dateEnd: '2023-02-01',
    //   all: false,
    //   term: ""
    // }
    const data = await getSalaryPayment(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchEmployeeSalary = async (req, res, next) => {
  try {
    const data = await getEmployeeSalary();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addStudent = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createStudent(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addStaff = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createStaff(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addClass = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createClass(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addSubject = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await createSubject(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addClassFee = async (req, res, next) => {
  const values = req.body;
  console.log("Data::", values);
  try {
    const data = await createClassFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addFee = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addSalary = async (req, res, next) => {
  const values = req.body;
  const deductions = values?.deductions;
  const allowances = values?.allowances;
  // console.log(values);
  try {
    const salary = await createSalary(values);
    const deductionPromises = deductions?.map((deduction) => {
      const newDeduction = {
        ...deduction,
        salaryId: salary.salaryId
      }
      return createDeduction(newDeduction);
    });
    const allowancePromises = allowances?.map((allowance) => {
      const newAllowance = {
      ...allowance,
        salaryId: salary.salaryId
      }
      return createAllowance(newAllowance);
    });
    
    const results = await Promise.allSettled([
      ...deductionPromises,
      ...allowancePromises
    ]);

    res.json({salary, results});
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addResult = async (req, res, next) => {
  const values = req.body;
  const marksData = values?.results;
  try {
    const promises = marksData?.map((mark) => createMarksResult({
      ...mark,
      class: values.class,
      term: values.term,
      studentId: values.studentId
    }));
    const results = await Promise.all([
      ...promises,
      createResult(values),
    ]);

    // results.forEach((result) => {
    //   if (result.status === 'rejected') {
    //     console.error(result.reason);
    //   }
    // });

    res.json(results);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addSalaryPayment = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createSalaryPayment(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addFeeding = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createFeeding(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addBusFee = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createBusFee(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const addExtraClasses = async (req, res, next) => {
  const values = req.body;
  // console.log(values);
  try {
    const data = await createExtraClasses(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

//needs more test
const markAttendance = async (req, res, next) => {
  const values = req.body;

  try {
    await removeAttendance(values);
    const termData = await getTerm();
    const promises = values.studentAttendance?.map((mark) => {
      // console.log(termData)
      const data = {
        ...mark,
        class: values.class,
        dateMarked: values.dateMarked,
        dateEnd: termData.dataValues.endDate
      }
      // console.log(data)
      createClassAttendance(data);
    });

    const results = await Promise.all([
      ...promises
    ]);

    res.json(results);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const assignSalary = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await _assignSalary(values);
    res.json(data);
  } catch (error) {
    next(error)
  }
}

const updateStudent = async (req, res, next) => {
  const values = req.body;
  const student_id = req.params.student_id;

  try {
    const data = await editStudent(values, student_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateStaff = async (req, res, next) => {
  const values = req.body;
  const teacher_id = req.params.teacher_id;

  try {
    const data = await editStaff(values, teacher_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateClass = async (req, res, next) => {
  const values = req.body;
  const id = req.params.class_id

  try {
    const data = await editClass(values, id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updateClassFee = async (req, res, next) => {
  const values = req.body;
  const id = req.params.class_fee_id

  try {
    const data = await editClassFee(values, id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteStudent = async (req, res, next) => {
  const student_id = req.params.student_id;

  try {
    const data = await removeStudent(student_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteStaff = async (req, res, next) => {
  const teacher_id = req.params.teacher_id;

  try {
    const data = await removeStaff(teacher_id);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const deleteResult = async (req, res, next) => {
  const info = req.query;
  const values = {
    studentId: info?.student_id,
    class: info?.class,
    term: info?.term,
    date: info?.date,
  };

  try {
    const data = await removeResult(values);
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error)
  }
};

const deleteFee = async (req, res, next) => {
  const id = req.params.fee_id;
  try {
    const data = await removeFee(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteSubject = async (req, res, next) => {
  const id = req.params.subject_id;
  try {
    const data = await removeSubject(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteSalary = async (req, res, next) => {
  const id = req.params.salary_id;
  try {
    const data = await Promise.allSettled([
      removeDeductions(id),
      removeAllowance(id),
      removeSalary(id)
    ]);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteSalaryPayment = async (req, res, next) => {
  const id = req.params.payment_id;
  try {
    const data = await removeSalaryPayment(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteClass = async (req, res, next) => {
  const id = req.params.class_id;
  try {
    const data = await removeClass(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteClassFee = async (req, res, next) => {
  const id = req.params.class_fee_id;
  try {
    const data = await removeClassFee(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteFeeding = async (req, res, next) => {
  const id = req.params.feeding_id;
  try {
    const data = await removeFeeding(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteExtraClasses = async (req, res, next) => {
  const id = req.params.extraclasses_id;
  try {
    const data = await removeExtraClasses(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteBusFee = async (req, res, next) => {
  const id = req.params.busfee_id;
  try {
    const data = await removeBusFee(id);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

const deleteAttendance = async (req, res, next) => {
  const values = req.body;
  try {
    const data = await removeAttendance(values);
    res.json(data);
  } catch (error) {
    console.log(error)
    next(error)
  }
}

//portal
const fetchNews = async (req, res, next) => {
  try {
    const data = await getNews();
    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const fetchUserDetails = async (req, res, next) => {
  const { userRole, id } = req.params.user;

  try {
    if (!userRole) {
      throw new Error("Not loggedn");
    }

    if (userRole === "STAFF") {
      const data = await getTeacherDetails(id);
      res.json(data);
    } else {
      const data = await getStudentDetails(id);
      res.json(data);
    }
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const resetPin = async (req, res, next) => {
  const { userRole, id } = req.params.user;
  let contact = "";
  try {
    if (!userRole) {
      throw new Error("Not loggedn");
    }

    if (userRole === "STAFF") {
      contact = await getTeacherContact(id);
    } else {
      contact = await getStudentContact(id);
    }

    const data = await sendResetPin([contact]);

    res.json(data);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

const updatePassword = async (req, res, next) => {
  const { userRole, id } = req.params.user;
  const { password } = req.body;
  let response;

  try {
    if (!userRole) {
      throw new Error("Not loggedn");
    }

    if (userRole === "STAFF") {
      response = await changeTeacherPassword(id, password);
    } else {
      response = await changeStudentPassword(id, password);
    }

    res.json(response);
  } catch (error) {
    console.log(error);
    next(error);
  }
};

export {
  fetchAllStudents,
  fetchAllStaff,
  fetchClassResult,
  fetchClassMarks,
  fetchOneStudentResult,
  fetchAttendance,
  fetchFees,
  fetchOneFee,
  fetchFeeding,
  fetchExtraClasses,
  fetchBusFee,
  fetchSalary,
  fetchDeductions,
  fetchAllowances,
  fetchOneSalary,
  fetchSalaryPayment,
  fetchEmployeeSalary,

  addStudent,
  addStaff,
  addClass,
  addResult,
  addFee,
  addSubject,
  addSalary,
  addSalaryPayment,
  addFeeding,
  addBusFee,
  addExtraClasses,
  addClassFee,

  updateStudent,
  updateStaff,
  updateClass,
  updateClassFee,

  deleteStudent,
  deleteStaff,
  deleteResult,
  deleteFee,
  deleteSubject,
  deleteSalary,
  deleteSalaryPayment,
  deleteClass,
  deleteClassFee,
  deleteFeeding,
  deleteExtraClasses,
  deleteBusFee,
  deleteAttendance,

  markAttendance,
  assignSalary,

  fetchNews,
  fetchUserDetails,
  resetPin,
  updatePassword,
};
