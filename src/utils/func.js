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
