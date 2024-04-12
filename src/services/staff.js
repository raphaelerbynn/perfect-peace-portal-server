import { Op } from "sequelize";
import { Class, Teacher } from "../models/index.js";

export const getStaff = async () => {
  try {
    const staff = await Teacher.findAll({
      include: [
        {
          model: Class,
          as: "class_",
          attributes: ["name"],
        },
      ],
    });
    return staff;
  } catch (error) {
    console.log(error);
  }
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
    // const _class = await Class.findOne({
    //   attributes: ["class_id"],
    //   where: {
    //     name: data?.class,
    //   },
    // });

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

    await Class.update(
        {
            teacherId: id
        },
        {
            where: {
                classId: data.class
            }
        }
    )

    return response;
  } catch (error) {
    console.log(error);
  }
};
