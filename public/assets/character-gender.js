export const GENDER_VALUES = Object.freeze(['male', 'female']);

const FREELANCER_GENDERS = Object.freeze({
  Ayu: 'female',
  Fajar: 'male',
  Maya: 'female',
  Yoga: 'male',
  Reza: 'male',
  Sinta: 'female',
  Eko: 'male',
  Tania: 'female',
});

function normalizeSeed(seed) {
  const value = Number(seed);
  return Number.isFinite(value) ? Math.abs(Math.trunc(value)) : 0;
}

export function assertGender(gender) {
  if (!GENDER_VALUES.includes(gender)) {
    throw new TypeError('gender must be male or female');
  }
  return gender;
}

export function genderedLook(base, gender, seed = 0) {
  const validGender = assertGender(gender);
  const index = normalizeSeed(seed);
  const hairStyles = validGender === 'female' ? ['long', 'bun'] : ['short', 'side'];
  return {
    ...base,
    gender: validGender,
    hairStyle: hairStyles[index % hairStyles.length],
    outfit: validGender === 'female' ? 'blouse' : 'shirt',
  };
}

export function freelancerGender(name) {
  if (Object.hasOwn(FREELANCER_GENDERS, name)) return FREELANCER_GENDERS[name];
  const score = [...String(name)].reduce((sum, character) => sum + character.codePointAt(0), 0);
  return score % 2 === 0 ? 'female' : 'male';
}
