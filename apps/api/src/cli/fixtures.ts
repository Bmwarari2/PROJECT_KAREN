/** Deterministic fictional data helpers (never real people). */
export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FIRST_NAMES = [
  'Avery', 'Blake', 'Casey', 'Devon', 'Emerson', 'Finley', 'Gray', 'Harper', 'Indigo', 'Jordan', 'Kai', 'Logan', 'Morgan', 'Noel',
  'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Umber', 'Vale', 'Wren', 'Xen', 'Yael', 'Zion', 'Arden', 'Briar', 'Cove',
  'Dale', 'Ellis', 'Fable', 'Glen', 'Haven', 'Ira', 'Jules', 'Kit', 'Lark', 'Marlow', 'Nico', 'Onyx', 'Pax', 'Rory', 'Shiloh', 'Teagan',
];
export const LAST_NAMES = [
  'Example', 'Sample', 'Fictional', 'Placeholder', 'Testwood', 'Mockridge', 'Demoford', 'Specimen', 'Synthwell', 'Imagin', 'Pretendley',
  'Notreal', 'Madeup', 'Dummond', 'Fakesley', 'Proxy', 'Stubbs', 'Fixture', 'Seedling', 'Prototype', 'Draftly', 'Sketchley', 'Modelle',
];
export const JOB_TITLES = [
  'Software engineer', 'Senior software engineer', 'Product manager', 'Designer', 'Data analyst', 'Customer support specialist',
  'Account executive', 'Operations coordinator', 'Warehouse operative', 'Shift supervisor', 'Store associate', 'Finance analyst',
  'HR business partner', 'Recruiter', 'Marketing manager', 'Nurse', 'Care assistant', 'Driver', 'Barista', 'Chef',
];
export const DEPARTMENTS = ['Leadership', 'Engineering', 'Product', 'Operations', 'People', 'Sales', 'Marketing', 'Finance', 'Customer support', 'Logistics'];

export function personName(r: () => number) {
  const first = FIRST_NAMES[Math.floor(r() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(r() * LAST_NAMES.length)]!;
  return { first, last };
}

export function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

// Syllable-built names for sandboxes: clearly invented, from a space large enough that a sandbox
// generator can skip any candidate that collides with a name in the source tenant.
const SYL_START = ['Al', 'Bri', 'Cor', 'Dav', 'El', 'Fen', 'Gar', 'Hal', 'Is', 'Jor', 'Kel', 'Lin', 'Mor', 'Nev', 'Or', 'Pel', 'Quin', 'Ros', 'Sil', 'Tor', 'Ul', 'Ver', 'Wil', 'Yor', 'Zan'];
const SYL_MID = ['a', 'an', 'en', 'ia', 'in', 'is', 'o', 'on', 'or', 'ra', 'ri', 'us', 'yn', 'eth', 'ix'];
const SYL_END = ['by', 'dale', 'ford', 'ham', 'ley', 'mere', 'more', 'ridge', 'stead', 'ton', 'well', 'wick', 'worth', 'combe', 'field'];
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;

export function syntheticPersonName(r: () => number) {
  const first = `${pick(r, SYL_START)}${pick(r, SYL_MID)}${r() < 0.4 ? pick(r, SYL_MID) : ''}`;
  const last = `${pick(r, SYL_START)}${r() < 0.5 ? pick(r, SYL_MID) : ''}${pick(r, SYL_END)}`;
  return { first, last };
}
