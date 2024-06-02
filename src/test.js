const inputArray = [
    {
      assessment: 'Participate in conversation',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 1,
      unsatisfactory: 0,
      notApplicable: 0,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Identifying rything words',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 1,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 0,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Recites letter sounds A-Z',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 1,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 0,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Interested in reading',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Enjoys and values reading',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Recognize and identifies letters (Upper and lower case)',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Recognize and pronounce own name in print',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Able to pronounce 2 and 3 letter words',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Forms simple sentence',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Listens to short story',
      category: 'Language Development (Reading, Listening and Oral Skills)',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Follows classroom rules and routines',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Plays well with other children',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Complete tasks',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Expresses emotions in appropriate way',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Cooperate and shares with others',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Takes care of personal needs',
      category: 'Personal / Social / Emotional Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Demonstatrate basic locomotor abilities (running, jumping, hoppinh, catching, etc)',
      category: 'Physical Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    },
    {
      assessment: 'Shows balance while moving',
      category: 'Physical Development',
      satisfactory: 0,
      improved: 0,
      needsImprovement: 0,
      unsatisfactory: 0,
      notApplicable: 1,
      class: 'KG 1',
      term: '1',
      studentId: 162,
      promoted: ''
    }
  ];
  
  // Function to transform the array
  function transformArray(data) {
    const result = {};
  data.forEach(item => {
    const { category, assessment, satisfactory, improved, needsImprovement, unsatisfactory, notApplicable, ...rest } = item;
    
    const _cat = category.toLowerCase()
        const key = 
        _cat.includes("language") ? "languageDevelopment" : 
        _cat.includes("personal") ? "personalDevelopment" : 
        _cat.includes("physical") ? "physicalDevelopment" : 
        _cat.includes("cognitive") ? "cognitiveDevelopment" : "academicProgress"

    if (!result[key]) {
      result[key] = {};
    }

    const assessmentValue = satisfactory ? 'satisfactory' :
                            improved ? 'improved' :
                            needsImprovement ? 'needsImprovement' :
                            unsatisfactory ? 'unsatisfactory' :
                            notApplicable ? 'notApplicable' : null;

    if (assessmentValue) {
      result[key][assessment] = assessmentValue;
    }

    result.class = item.class;
    result.term = item.term;
    result.studentId = item.studentId;
    result.promoted = item.promoted;
  });
  return result;
  }

  function transformArrayMe(inputArray) {
    let result = {}

    

    return result
  }
  
  // Transform the array
  const transformedArray = transformArray(inputArray);
//   const transformedArray = transformArrayMe(inputArray);
  
  console.log(transformedArray);
  