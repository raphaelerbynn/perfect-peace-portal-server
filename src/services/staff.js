import { Op } from "sequelize";
import { Class, Salary, Teacher } from "../models/index.js";

// BE-20: optional, backward-compatible pagination. No options => identical
// behaviour and shape as before (full array). limit/offset only applied when
// pagination params are supplied.
export const getStaff = async (options = {}) => {
  // BE-D6: do NOT swallow DB errors. The previous catch returned undefined so
  // the controller responded HTTP 200 with an empty body on failure. Let it
  // propagate; `fetchAllStaff` forwards it to the central errorHandler.
  // Success-path shape is unchanged.
  const { page, limit } = options;

  const queryOptions = {
    attributes: { exclude: ["password"] },
    include: [
      {
        model: Class,
        as: "class_",
        attributes: ["name"],
      },
      {
        model: Salary,
        as: "salary",
      },
    ],
  };

  const parsedLimit = parseInt(limit, 10);
  const parsedPage = parseInt(page, 10);
  if (Number.isInteger(parsedLimit) && parsedLimit > 0) {
    queryOptions.limit = parsedLimit;
    const safePage = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    queryOptions.offset = (safePage - 1) * parsedLimit;
    queryOptions.subQuery = false;
  }

  const staff = await Teacher.findAll(queryOptions);
  return staff;
};

// Public, minimal staff list for the PRE-LOGIN signup picker only.
// Returns id + name exclusively — never password, contact, bank or other PII —
// so it is safe to expose unauthenticated (replaces the old unauthenticated
// /staff dump). Throws on error so the controller can forward via next().
export const getStaffForSignup = async () => {
  return Teacher.findAll({
    attributes: ["teacherId", "fName", "lName"],
    order: [["fName", "ASC"]],
  });
};

export const removeStaff = async (id) => {
  try {
    const response = await Promise.allSettled([
      Teacher.destroy({
        where: {
          teacherId: id,
        },
      }),
    ]);

    return response;
  } catch (error) {
    console.log(error);
  }
};

export const createStaff = async (data) => {
  try {
    const response = await Teacher.create({
      fName: data.fName,
      lName: data.lName,
      gender: data.gender,
      phone: data.phone,
      email: data.email,
      address: data.address,
      category: data.category,
      ssnitNumber: data.ssnit,
      tinNumber: data.tin,
      bank: data.bank,
      accountNumber: data.account,
      dateRegistered: Date.now(),
      classId: data.class_id,
    });

    return response;
  } catch (error) {
    console.log(error);
  }
};

export const editStaff = async (data, id) => {
  try {
    // If a class is provided, ensure it doesn't already have a different teacher
    if (data?.class) {
      const targetClass = await Class.findOne({
        where: {
          classId: data.class,
        },
      });

      if (targetClass && targetClass.teacherId && targetClass.teacherId !== id) {
        return { success: false, message: "Teacher already assigned, remove teacher first" };
      }
    }

    const response = await Teacher.update(
      {
        fName: data.fName,
        lName: data.lName,
        gender: data.gender,
        phone: data.phone,
        email: data.email,
        address: data.address,
        category: data.category,
        ssnitNumber: data.ssnit,
        tinNumber: data.tin,
        bank: data.bank,
        accountNumber: data.account,
        dateUpdated: Date.now(),
        classId: data.class,
        salaryId: data.salaryId || null,
      },
      {
        where: {
          teacherId: id,
        },
      }
    );
    
    await Class.update(
        {
            teacherId: null
        },
        {
            where: {
                teacherId: id
            }
        }
    )

    if (data?.class) {
      await Class.update(
        {
          teacherId: id,
        },
        {
          where: {
            classId: data.class,
          },
        }
      );
    }

    return response;
  } catch (error) {
    console.log(error);
  }
};
