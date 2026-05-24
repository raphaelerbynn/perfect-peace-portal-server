import { Class, ClassFee, Student, Teacher } from "../models/index.js";

const classes = async () => {
  const classFeeList = await ClassFee.findAll({ raw: true });

  const allClasses = await Class.findAll();

  // BE-19: replace the per-class `Student.count()` (N+1 queries) with a single
  // grouped count, then merge into each class in memory. Returned shape is
  // unchanged (each Class instance gets `totalStudents` + `feeList`).
  //
  // BE-D10 — definition of "counted students" for the bar chart:
  //   Each class tile shows the ACTUAL number of students currently assigned to
  //   that class (`Student.classId === class_id`), with NO special-casing of the
  //   graduated/alumni classes (GRADUATED_CLASS_IDS) — if class 39/40 still hold
  //   students, their real count is shown on their own tile.
  //   Reconciliation with /dashboard-summary:
  //     - SUM(all tiles)                = every student WITH a classId
  //     - SUM(non-graduated tiles)      = dashboard `activeStudents`
  //     - dashboard `totalStudents`     = SUM(all tiles) + students with classId = null
  //   Students with `classId = null` intentionally have NO tile (they belong to
  //   no class), which is why the all-tiles sum can be < totalStudents. This is
  //   the one consistent rule applied across the dashboard.
  const countRows = await Student.count({
    group: ["classId"],
  });

  // Sequelize returns `[{ classId, count }, ...]` when `group` is used.
  const countByClassId = new Map(
    countRows.map((row) => [row.classId, row.count])
  );

  const classData = allClasses.map((classItem) => {
    const classId = classItem.classId;

    const feeList = classFeeList.filter((fee) => fee.classId === classId);

    classItem.dataValues.totalStudents = countByClassId.get(classId) || 0;
    classItem.dataValues.feeList = feeList;

    return classItem;
  });

  return classData;
};

const createClass = async (data) => {
  // BE-D12: use the row returned by Class.create() (its real PK) instead of
  // re-querying findOne({ where: { teacherId } }). The old lookup returned the
  // WRONG class when a teacher was already assigned to another class, and broke
  // entirely (null deref) when teacher_id was absent.
  const newClass = await Class.create({
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

  if (data.teacher_id) {
    await Teacher.update(
      {
        classId: newClass.classId,
      },
      {
        where: {
          teacherId: data.teacher_id,
        },
      }
    );
  }

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
  // get current class to determine previous teacher
  const existingClass = await Class.findOne({
    where: { classId: id },
    raw: true,
  });

  const previousTeacherId = existingClass?.teacherId || null;

  await Class.update(
    {
      name: data?.name,
      section: data?.section,
      teacherId: data?.teacher_id,
    },
    {
      where: {
        classId: id,
      },
      returning: true,
    }
  );

  // If the class had a previous teacher and it's different from the new one, clear that teacher's classId
  if (previousTeacherId && previousTeacherId !== data?.teacher_id) {
    await Teacher.update(
      { classId: null },
      { where: { teacherId: previousTeacherId } }
    );
  }

  // If a new teacher is assigned, set that teacher's classId to this class
  if (data?.teacher_id) {
    await Teacher.update(
      { classId: id },
      { where: { teacherId: data.teacher_id } }
    );
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

const getClassIdByName = async (name, transaction = null) => {
  if (!name) {
    throw new Error('Class name is required');
  }

  const result = await Class.findOne({
    attributes: ["classId"],
    where: { name },
    raw: true,
    transaction
  });

  if (!result) {
    return null;
  }

  return result.classId;
};

export { createClass, removeClass, classes, createClassFee, editClassFee, removeClassFee, editClass, getClassIdByName };
