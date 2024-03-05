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
  const updatedClass = await Class.update(
    {
      name: data?.name,
      section: data?.section,
      teacher_id: data?.teacher_id,
      fees: data?.fees,
    },
    {
      where: {
        class_id: id,
      },
    }
  );

  if (data.teacher_id) {
    const updateTeacher = await Teacher.update(
      {
        class_id: updatedClass.class_id,
      },
      {
        where: {
          teacher_id: data.teacher_id,
        },
      }
    );
    // console.log(updateTeacher);
  }

  return updatedClass;
};

const removeClass = async (id) => {
  const deletedClass = await Class.destroy({
    where: {
      class_id: id,
    },
  });

  const updateTeacher = await Teacher.update(
    {
      classId: '',
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
      class_fee_id: id,
    },
  });

  return deletedClassFee;
};

export { createClass, removeClass, classes, createClassFee, editClassFee, removeClassFee, editClass };
