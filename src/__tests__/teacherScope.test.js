// B2: who may score / take the register. Rule ported from SchoolPro's
// teacher-scope.service(.spec).ts. Models mocked, no DB.
jest.mock("../models/index.js", () => ({
  __esModule: true,
  TeachingAssignment: { findAll: jest.fn() },
  Class: { findAll: jest.fn(), findOne: jest.fn() },
  Subject: { findAll: jest.fn() },
  Teacher: { findOne: jest.fn(), count: jest.fn() },
}));

import { Class, Subject, Teacher, TeachingAssignment } from "../models/index.js";
import {
  allows,
  canScore,
  canTakeRegister,
  isKgSection,
  loadScope,
  loadTeacher,
  scopedClasses,
} from "../services/teacherScope.js";

// Fixture school, term 5:
//   JHS 1 (classId 1): class teacher = Ama (teacherId 10). Maths assigned to Kofi (11).
//   JHS 2 (classId 2): class teacher = Kofi (11). Science assigned to Esi (12).
//   KG 1  (classId 3): class teacher = Ama.
const MATHS = 100;
const SCIENCE = 101;
const ENGLISH = 102;
const assignments = [
  { teacherId: 11, termId: 5, classId: 1, subjectId: MATHS },
  { teacherId: 12, termId: 5, classId: 2, subjectId: SCIENCE },
  { teacherId: 11, termId: 4, classId: 2, subjectId: ENGLISH }, // last term
];
const classes = [
  { classId: 1, name: "JHS 1", section: "JHS", teacherId: 10, isDeleted: false },
  { classId: 2, name: "JHS 2", section: "JHS", teacherId: 11, isDeleted: false },
  { classId: 3, name: "KG 1", section: "KG", teacherId: 10, isDeleted: false },
];
const subjects = [
  { subjectId: ENGLISH, name: "English" },
  { subjectId: MATHS, name: "Maths" },
  { subjectId: SCIENCE, name: "Science" },
];

// Minimal Sequelize-where evaluator for the fields the service queries.
const match = (row, where) =>
  Object.entries(where).every(([k, cond]) => {
    if (cond && typeof cond === "object") {
      const syms = Object.getOwnPropertySymbols(cond);
      return syms.every((sym) => {
        const v = cond[sym];
        if (sym.toString().includes("in")) return v.includes(row[k]);
        if (sym.toString().includes("ne")) return row[k] !== v;
        throw new Error(`unhandled op ${sym.toString()}`);
      });
    }
    return row[k] === cond;
  });

beforeEach(() => {
  jest.resetAllMocks();
  TeachingAssignment.findAll.mockImplementation(async ({ where }) => assignments.filter((a) => match(a, where)));
  Class.findAll.mockImplementation(async ({ where }) => classes.filter((c) => match(c, where)));
  Subject.findAll.mockResolvedValue(subjects);
});

const key = (classId, subjectId, termId = 5) => ({ termId, classId, subjectId });

describe("allows (the scope rule)", () => {
  it("lets the assigned subject teacher score their subject", async () => {
    expect(await canScore(11, key(1, MATHS))).toBe(true);
  });

  it("refuses a JHS 1 Maths teacher writing JHS 2 Science", async () => {
    // Kofi teaches JHS 1 Maths and is JHS 2's class teacher, but Science in
    // JHS 2 is assigned to Esi.
    expect(await canScore(11, key(2, SCIENCE))).toBe(false);
  });

  it("class-teacher fallback: any subject nobody else is assigned in their class", async () => {
    expect(await canScore(11, key(2, MATHS))).toBe(true); // JHS 2 Maths unassigned
    expect(await canScore(10, key(1, ENGLISH))).toBe(true); // Ama, JHS 1 English unassigned
  });

  it("the class teacher loses a subject once it is assigned to someone else", async () => {
    expect(await canScore(10, key(1, MATHS))).toBe(false); // JHS 1 Maths is Kofi's
  });

  it("refuses a teacher with no assignment and no class", async () => {
    expect(await canScore(12, key(1, MATHS))).toBe(false);
  });

  it("does not carry an assignment across terms", async () => {
    // Esi teaches JHS 2 Science in term 5, not term 6.
    expect(await canScore(12, key(2, SCIENCE, 6))).toBe(false);
    expect(await canScore(12, key(2, SCIENCE, 5))).toBe(true);
  });

  it("compares ids as numbers (query strings arrive as text)", () => {
    const scope = { own: [{ termId: 5, classId: 1, subjectId: MATHS }], classTeacherOf: [], othersInMyClasses: [] };
    expect(allows(scope, { termId: "5", classId: "1", subjectId: String(MATHS) })).toBe(true);
  });

  it("narrows the scope queries by term and class", async () => {
    await loadScope(11, { termId: 5, classId: 1 });
    expect(TeachingAssignment.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: { teacherId: 11, termId: 5, classId: 1 } })
    );
  });
});

describe("register", () => {
  it("is the class teacher's only (client default)", async () => {
    expect(await canTakeRegister(10, 1, { termId: 5 })).toBe(true); // Ama, JHS 1
    expect(await canTakeRegister(11, 1, { termId: 5 })).toBe(false); // Kofi teaches Maths there
  });
});

describe("scopedClasses (portal pickers)", () => {
  it("lists only the subjects the teacher may score, per class, naturally sorted", async () => {
    const kofi = await scopedClasses(11, { termId: 5 });
    expect(kofi.map((c) => c.name)).toEqual(["JHS 1", "JHS 2"]);
    const [jhs1, jhs2] = kofi;
    expect(jhs1).toMatchObject({ isClassTeacher: false, takesRegister: false });
    expect(jhs1.subjects.map((s) => s.name)).toEqual(["Maths"]);
    expect(jhs2).toMatchObject({ isClassTeacher: true, takesRegister: true });
    expect(jhs2.subjects.map((s) => s.name)).toEqual(["English", "Maths"]); // not Science (Esi's)
  });

  it("a KG class: the class teacher gets the register and the KG learning areas to score", async () => {
    const ama = await scopedClasses(10, { termId: 5 });
    const kg = ama.find((c) => c.name === "KG 1");
    expect(kg).toMatchObject({ isKg: true, takesRegister: true });
    expect(kg.subjects.map((s) => s.name)).toEqual(["Language/Literacy", "Numeracy", "Phonics", "Creative Arts", "Environmental Science"]);
    expect(kg.subjects[0].subjectId).toBe("kg-1");
  });

  it("is empty for a teacher with nothing assigned", async () => {
    expect(await scopedClasses(99, { termId: 5 })).toEqual([]);
  });
});

describe("loadTeacher", () => {
  it("refuses an archived or unknown teacher (403)", async () => {
    Teacher.findOne.mockResolvedValue(null);
    await expect(loadTeacher(3)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns the teacher with a display name", async () => {
    Teacher.findOne.mockResolvedValue({ teacherId: 3, fName: "Ama", lName: "Owusu" });
    await expect(loadTeacher(3)).resolves.toMatchObject({ teacherId: 3, name: "Ama Owusu" });
    expect(Teacher.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { teacherId: 3, isDeleted: false } }));
  });
});

it("recognises KG sections, including the legacy spellings", () => {
  for (const s of ["KG", "Nursery", "Nursury", "Creche", "crech", " kg "]) expect(isKgSection(s)).toBe(true);
  for (const s of ["JHS", "Primary", null, undefined]) expect(isKgSection(s)).toBe(false);
});

describe("class with no teacher on its record (live: KG 2)", () => {
  // KG 2 (classId 15) has no class teacher on the class; Gloria (teacherId 20)
  // names it on her own staff record.
  const kg2 = { classId: 15, name: "KG 2", section: "KG", teacherId: null, isDeleted: false };
  beforeEach(() => {
    Class.findAll.mockImplementation(async ({ where }) => [...classes, kg2].filter((c) => match(c, where)));
    Teacher.findOne.mockImplementation(async ({ where }) => (where.teacherId === 20 ? { classId: 15 } : null));
  });

  it("counts her as the class teacher when she is the only one naming it", async () => {
    Teacher.count.mockResolvedValue(1);
    expect((await loadScope(20, { termId: 5 })).classTeacherOf).toEqual([15]);
    expect(await canTakeRegister(20, 15, { termId: 5 })).toBe(true);
  });

  it("not when two staff records name the class (ambiguous)", async () => {
    Teacher.count.mockResolvedValue(2);
    expect((await loadScope(20, { termId: 5 })).classTeacherOf).toEqual([]);
  });

  it("not when the class has its own class teacher", async () => {
    Teacher.findOne.mockResolvedValue({ classId: 3 }); // KG 1 belongs to Ama
    Teacher.count.mockResolvedValue(1);
    expect((await loadScope(20, { termId: 5 })).classTeacherOf).toEqual([]);
  });
});
