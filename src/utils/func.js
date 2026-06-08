export function transformReturningKGResult(data) {
  const result = {};
  data.forEach((item) => {
    const {
      category,
      assessment,
      satisfactory,
      improved,
      needsImprovement,
      unsatisfactory,
      notApplicable,
      ...rest
    } = item;
    // console.log(rest)

    const _cat = category.toLowerCase()
    const key = 
        _cat.includes("language") ? "languageDevelopment" : 
        _cat.includes("personal") ? "personalDevelopment" : 
        _cat.includes("physical") ? "physicalDevelopment" : 
        _cat.includes("cognitive") ? "cognitiveDevelopment" : "academicProgress"

    if (!result[key]) {
      result[key] = {};
    }

    const assessmentValue = satisfactory
      ? "satisfactory"
      : improved
      ? "improved"
      : needsImprovement
      ? "needs_improvement"
      : unsatisfactory
      ? "unsatisfactory"
      : notApplicable
      ? "not_applicable"
      : null;

    if (assessmentValue) {
      result[key][assessment] = assessmentValue;
    } else {
        console.log(assessment)
        result[key][assessment] = {
            classScore: rest.classScore,
            examScore: rest.examScore,
            totalScore: rest.totalScore,
            classP: rest.classScorePercentage,
            examP: rest.examScorePercentage,
        };
    }

    result.class = item.class;
    result.term = item.term;
    result.studentId = item.studentId;
    result.promoted = item.promoted;
  });

  console.info(result)

  return result;
}

// BE-9: interpolate {{key}} placeholders, but SANITIZE the substituted values —
// they can include client-supplied names. Strip newlines and braces (so a value
// can't inject another {{token}} or distort the body) and clamp length so a
// crafted value can't inflate the billable segment count.
export const composeMessage = (data, message) => {
  Object.keys(data || {}).forEach(key => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    const safe = (data[key] == null ? "" : String(data[key]))
      .replace(/[\r\n]+/g, " ")
      .replace(/[{}]/g, "")
      .slice(0, 120);
    message = message.replace(regex, safe);
  });

  return message;
};

export const isValidPhoneNumber = (phone) => {
  const cleanedPhone = phone.trim();
  const phoneRegex = /^\+?\d{10,15}$/;
  return phoneRegex.test(cleanedPhone);
}

// Compute age from a date of birth using a real date diff (BE-25).
// The previous implementation subtracted years only (currentYear - birthYear),
// which over-counts by one for anyone whose birthday hasn't occurred yet this
// year. This decrements when the current month/day is before the birthday.
export const calculateAge = (dob) => {
  if (!dob) return null;

  const birthDate = new Date(dob);
  if (isNaN(birthDate.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();

  const monthDiff = today.getMonth() - birthDate.getMonth();
  const dayDiff = today.getDate() - birthDate.getDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age--;
  }

  return age < 0 ? null : age;
}