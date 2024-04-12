import { raw } from "mysql2";
import { Class, ClassFee, Student, Teacher } from "../models/index.js";

const classes = async () => {
  const classFeeList = await ClassFee.findAll({ raw: true });

  const allClasses = await Class.findAll();
  
  const classData = await Promise.all(
    allClasses.map(async (classItem) => {
      const classId = classItem.classId;

      const studentCount = await Student.count({
        where: {
          classId: classId,
        },
      });

      const feeList = classFeeList.filter((fee) => fee.classId === classId)

      classItem.dataValues.totalStudents = studentCount;
      classItem.dataValues.feeList = feeList;

      return classItem;
    })
  );

  return classData;
};

const createClass = async (data) => {
  await Class.create({
    name: data?.name,
    section: data?.section,
    capacity: data?.capacity,
    teacherId: data?.teacher_id,

    //fees dismantled
    tuition: data?.tuitionFee,
    firstAid: data?.firstAidFee,
    pta: data?.ptaFee,
    water: data?.waterFee,
    maintenance: data?.maintenanceFee,
    stationary: data?.stationaryFee,
    cocurricular: data?.cocurricular,

    fees: data?.fees,
  });

  const newClass = await Class.findOne({
    where: {
      teacherId: data?.teacher_id,
    },
  });

  if (data.teacher_id) {
    const updateTeacher = await Teacher.update(
      {
        classId: newClass.dataValues.classId,
      },
      {
        where: {
          teacherId: data.teacher_id,
        },
      }
    );
    // console.log(updateTeacher);
    // console.log(newClass);
  }

  // console.log(newClass);
  return newClass;
};

const createClassFee = async (data) => {
  // console.log("Data::", data);
  return await ClassFee.create({
    name: data?.name,
    amount: data?.amount,
    classId: data?.classId,
  });
}

const editClassFee = async (data, id) => {
  // console.log("Data::", data);
  return await ClassFee.update({
    name: data?.name,
    amount: data?.amount,
  },
  {
    where: {
      classFeeId: id
    }
  });
}

const editClass = async (data, id) => {
  console.log(id, data)
  await Class.update(
    {
      name: data?.name,
      section: data?.section,
      teacherId: data?.teacher_id
    },
    {
      where: {
        classId: id,
      },
      returning: true,
    },
  );

  if (data.teacher_id) {
    const updatedClass = await Class.findOne({
      where: {
        classId: id,
      },
      raw: true 
    });
    console.log(updatedClass)
    
    const updateTeacher = await Teacher.update(
      {
        classId: updatedClass.classId,
      },
      {
        where: {
          teacherId: updatedClass.teacherId,
        },
      }
    );
    // console.log(updateTeacher);
  }

  return "updated";
};

const removeClass = async (id) => {
  const deletedClass = await Class.destroy({
    where: {
      class_id: id,
    },
  });

  const updateTeacher = await Teacher.update(
    {
      classId: null,
    },
    {
      where: {
        classId: id,
      },
    }
  );

  return deletedClass;
};

const removeClassFee = async (id) => {
  const deletedClassFee = await ClassFee.destroy({
    where: {
      classFeeId: id,
    },
  });

  return deletedClassFee;
};

export { createClass, removeClass, classes, createClassFee, editClassFee, removeClassFee, editClass };
