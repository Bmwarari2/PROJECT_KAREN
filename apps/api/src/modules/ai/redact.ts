import { scrubString } from '@thapsus/core/scrub';
import type { Tx } from '@thapsus/db';

/**
 * Removes people identifiers before anything is sent to the model: the core scrubber (emails, phone
 * numbers, NI numbers, SSNs, tokens) plus names and employee numbers of anyone in the tenant's
 * employee directory. Applied to the question and to every policy excerpt.
 */
export const PERSON = '[person]';
export const EMPLOYEE_NUMBER = '[employee number]';

/**
 * Words that are also names. Lower-case or sentence-initial uses are treated as words; Capitalised
 * uses inside a sentence are treated as names. Everything else that matches a directory name is removed.
 */
const COMMON_WORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having here how i if in into is it its just more most no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours ' +
    'leave holiday holidays annual sick sickness pay paid payslip salary bonus pension policy policies employee employees staff manager managers team work working hours day days week weeks month months year years notice period probation contract rights right parental maternity paternity adoption shared family carer carers bereavement compassionate jury service training expenses travel overtime shift shifts rota flexible remote home office benefits benefit company business hr human resources review performance appraisal promotion grievance disciplinary conduct dress code health safety equal opportunities diversity inclusion' +
    ' will may june april august march mark bill rose grace hope joy faith sky summer autumn winter spring frank art guy max jack ray dawn eve ivy lily iris holly heather amber ruby pearl jade crystal sunny rich pat sue sage river storm august christian major page cook baker taylor mason carter hunter fisher miller wood hill green brown white black young king long short'
  )
    .split(/\s+/)
    .filter(Boolean),
);

interface Token {
  word: string;
  start: number;
  end: number;
  capitalised: boolean;
  sentenceStart: boolean;
}

export function wordTokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}][\p{L}\p{M}]*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text.slice(0, m.index).replace(/[\s"'(\[‘“]+$/u, '');
    out.push({
      word: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
      capitalised: /^\p{Lu}/u.test(m[0]),
      sentenceStart: before === '' || /[.!?:\n]$/.test(before) || /\n\s*$/.test(text.slice(0, m.index)),
    });
  }
  return out;
}

/** Whether a directory name match at this position should be removed. */
export function shouldRedactName(t: Token): boolean {
  if (t.word.length < 2) return false;
  if (t.capitalised && !t.sentenceStart) return true;
  return !COMMON_WORDS.has(t.word);
}

/**
 * Employee-number candidates: tokens mixing letters and digits (the default format is E000123) or pure
 * digit runs of 5 or more. Short plain numbers ("25 days", "2026") are policy content, not identifiers.
 */
const NUMBER_TOKEN = /\b[\p{L}\p{N}][\p{L}\p{N}_/-]*\d[\p{L}\p{N}_/-]*\b/gu;
const isNumberCandidate = (s: string) => (/\p{L}/u.test(s) && /\d/.test(s)) || /^\d{5,}$/.test(s);
const numberCandidates = (text: string) => [...text.matchAll(NUMBER_TOKEN)].filter((m) => isNumberCandidate(m[0]));

export interface RedactionResult {
  texts: string[];
  /** A name or number of an employee other than the asker appeared in the first text (the question). */
  questionMentionsColleague: boolean;
}

export async function redactPeople(tx: Tx, texts: string[], askerEmployeeId: string | null): Promise<RedactionResult> {
  const scrubbed = texts.map((t) => scrubString(t));
  const tokens = scrubbed.map(wordTokens);
  const probe = new Set<string>();
  for (const list of tokens) for (const t of list) if (shouldRedactName(t)) probe.add(t.word);
  const numbers = new Set<string>();
  for (const s of scrubbed) for (const m of numberCandidates(s)) {
    numbers.add(m[0]);
    numbers.add(m[0].toUpperCase());
  }
  const words = [...probe].slice(0, 2_000);
  const names = new Map<string, boolean>(); // word → matches someone other than the asker
  if (words.length) {
    const rows = await tx.query<{ token: string; other: boolean }>(
      `SELECT t AS token, bool_or(e.id IS DISTINCT FROM $2::uuid) AS other
         FROM unnest($1::text[]) AS t
         JOIN LATERAL (
           SELECT e.id FROM app.employees e
            WHERE e.search @@ plainto_tsquery('simple', t)
              AND NOT (to_tsvector('simple', coalesce(e.job_title, '')) @@ plainto_tsquery('simple', t))
            LIMIT 2
         ) e ON true
        GROUP BY t`,
      [words, askerEmployeeId],
    );
    for (const r of rows) names.set(r.token, r.other);
  }
  const numberHits = new Map<string, boolean>();
  if (numbers.size) {
    const rows = await tx.query<{ employee_number: string; id: string }>(`SELECT employee_number, id FROM app.employees WHERE employee_number = ANY($1::text[])`, [[...numbers]]);
    for (const r of rows) numberHits.set(r.employee_number.toUpperCase(), (numberHits.get(r.employee_number.toUpperCase()) ?? false) || r.id !== askerEmployeeId);
  }
  let mentionsColleague = false;
  const out = scrubbed.map((text, i) => {
    const spans: Array<[number, number, string]> = [];
    for (const t of tokens[i]!) {
      if (!names.has(t.word) || !shouldRedactName(t)) continue;
      spans.push([t.start, t.end, PERSON]);
      if (i === 0 && names.get(t.word)) mentionsColleague = true;
    }
    for (const m of numberCandidates(text)) {
      const hit = numberHits.get(m[0].toUpperCase());
      if (hit === undefined) continue;
      spans.push([m.index!, m.index! + m[0].length, EMPLOYEE_NUMBER]);
      if (i === 0 && hit) mentionsColleague = true;
    }
    // Keep the longest span where two overlap (e.g. a name-like prefix of an employee number).
    spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const kept: Array<[number, number, string]> = [];
    for (const sp of spans) if (!kept.length || sp[0] >= kept[kept.length - 1]![1]) kept.push(sp);
    let s = text;
    for (const [a, b, rep] of kept.reverse()) s = s.slice(0, a) + rep + s.slice(b);
    return s.replace(/\[person\](?:[\s'’-]+\[person\])+/g, PERSON);
  });
  return { texts: out, questionMentionsColleague: mentionsColleague };
}
