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
