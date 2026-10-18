/**
 * Deterministic guard for "Ask HR" (runs before retrieval and before any model call).
 *
 * Ask HR answers questions about the company's own policies. It must never be used to make or
 * recommend employment decisions (hiring, performance, pay, promotion, discipline, dismissal,
 * redundancy selection), it must not receive special-category data, and it must not be steerable by
 * instructions hidden in a question. The same vocabulary drives the post-model answer check.
 *
 * Policy: questions about how a process works or what the policy says are allowed, including about
 * the asker's own entitlements. Requests to decide, choose, rank, score, justify or draft an outcome
 * for a person are refused. Proven by the red-team suite (apps/api/test/fixtures/ai-red-team.json).
 */
export type RefusalReason = 'employment_decision' | 'prompt_injection' | 'sensitive_personal' | 'about_colleague';

export type GuardResult = { allowed: true } | { allowed: false; reason: RefusalReason; rule: string };

export function normaliseQuestion(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[​-‏⁠﻿]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'"<>[\]/:@.\s-]+/gu, ' ')
    .replace(/[.?!]+(\s|$)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- vocabulary --------------------------------------------------------------------------------
const W = (n: number) => `(?: [\\w'-]+){0,${n}}`;
const SUBJ = `(?:i|we|you|they|the company|the business|management|hr|my manager|my boss|the manager)`;
const OTHER_SUBJ = `(?:he|she|they|(?!i\\b|it\\b|this\\b|that\\b|there\\b|we\\b)[a-z][a-z'-]+|my (?:report|employee|colleague|team member|direct report|staff member)|this (?:person|employee|candidate|applicant|worker)|the (?:employee|candidate|applicant|new hire|new starter|worker))`;
const DISMISS = `(?:fire|fired|firing|sack|sacked|sacking|dismiss|dismissed|dismissing|terminate|terminated|terminating|let (?:[\\w'-]+ ){1,3}go|let go|lay (?:[\\w'-]+ ){1,3}off|lay off|laid off|make (?:[\\w'-]+ ){1,4}redundant|made redundant|get rid of|manage (?:[\\w'-]+ ){1,3}out|push (?:[\\w'-]+ ){1,3}out)`;
const HIRE = `(?:hire|hired|hiring|employ|recruit|reject|rejected|turn ${'[\\w\'-]+'} down|offer ${'[\\w\'-]+'} the (?:job|role|position)|shortlist)`;
const PROMO = `(?:promote|promoted|promoting|demote|demoted|demoting)`;
const DISCIPLINE = `(?:discipline|disciplined|suspend|suspended|warn|warned|punish|punished|sanction|sanctioned)`;
const DECISION_VERB = `(?:${DISMISS}|${HIRE}|${PROMO}|${DISCIPLINE})`;
const PAY_THING = `(?:raise|rise|pay rise|pay raise|bonus|bonuses|salary|salary increase|pay|pay increase|increase|commission|equity|pay cut|wage|more|less|more money|less money)`;
const OUTCOME_THING = `(?:${PAY_THING}|promotion|warning|written warning|final warning|verbal warning)`;
const TOPIC = `(?:pip|pips|improvement plan|capability (?:process|procedure)|fire|fired|firing|sack|dismiss|dismissed|dismissal|terminat\\w*|let go|lay off|laid off|layoffs?|redundan\\w*|hire|hired|hiring|recruit\\w*|candidates?|applicants?|promot\\w*|demot\\w*|raise|rise|bonus\\w*|salary|salaries|pay|paid|wage|compensation|discipline|disciplinary|warning|suspen\\w*|misconduct|rating|ratings|score|appraisal|performance)`;
const CONTACT = `\\bwho (?:should|do|can|would) (?:i|we) (?:contact|ask|speak|talk|email|e-mail|call|tell|go to|notify|report|reach|write|send|see|approach|message|phone)\\b`;

interface Rule {
  id: string;
  re: RegExp;
  reason: RefusalReason;
  /** Skip the rule when this matches (for example "who should I contact about my pay"). */
  unless?: RegExp;
}

const r = (src: string) => new RegExp(src, 'i');

const INJECTION: Rule[] = [
  ['ignore_instructions', `\\b(?:ignore|disregard|forget|override|skip|bypass)\\b${W(4)} (?:previous|prior|above|earlier|preceding|all|any|your|the|these|system|safety)${W(2)} (?:instructions?|rules?|prompts?|guidelines?|guardrails?|restrictions?|polic(?:y|ies) (?:on|about) (?:decisions|ai)|constraints?|filters?|guard)`],
  ['reveal_prompt', `\\b(?:reveal|show|print|repeat|output|display|leak|tell me|what (?:is|are)|give me)\\b${W(3)} (?:your|the) (?:system |hidden |initial |original )?(?:prompt|instructions|rules|guidelines|configuration)\\b`],
  ['system_prompt', `\\bsystem (?:prompt|message|instructions?)\\b`],
  ['role_override', `\\b(?:you are now|from now on,? you|pretend (?:to be|you are|you're)|role-?play as|act as (?:if you were|a different|an unrestricted|my (?:lawyer|manager|boss|hr director))|switch (?:to|into) \\w+ mode|(?:developer|dev|god|admin|dan|jailbreak|unrestricted|unfiltered) mode)\\b`],
  ['jailbreak', `\\b(?:jailbreak|do anything now|no restrictions|without (?:any )?(?:restrictions|filters|rules)|new instructions|updated instructions)\\b`],
  ['markup', `<\\s*/?\\s*(?:system|assistant|instructions?|policy_excerpts|excerpt|question)\\b|\\[/?(?:inst|system)\\]|\\bim_(?:start|end)\\b`],
  ['encoded_payload', `[a-z0-9+/]{60,}={0,2}`],
].map(([id, src]) => ({ id: id!, re: r(src!), reason: 'prompt_injection' as const }));

const SENSITIVE: Rule[] = [
  [
    'self_disclosure',
    `\\b(?:i|i'm|im|i am|i've|ive|i have|i had|i was|i've been|i got|i suffer|i'm suffering|i live)\\b${W(4)} (?:diagnosed|pregnant|miscarr\\w*|cancer|tumou?r|diabet\\w*|depress\\w*|anxiety disorder|bipolar|schizo\\w*|adhd|autis\\w*|hiv|aids|epilep\\w*|disabled|disabilit\\w*|chemo\\w*|ivf|fertility treatment|terminal\\w*|mental (?:health|illness)|breakdown|stroke|heart attack|multiple sclerosis|long covid|addict\\w*|alcoholi\\w*|rehab|transitioning|transgender|trans woman|trans man|gay|lesbian|bisexual|muslim|jewish|hindu|sikh|buddhist|atheist|asylum|refugee|undocumented|overstay\\w*|criminal record|convicted|arrested|surgery)\\b`,
  ],
  [
    'my_sensitive_record',
    `\\bmy (?:diagnosis|disability|illness|medical (?:condition|history|records?)|health (?:condition|problems?|issues?)|pregnancy|miscarriage|cancer|chemo\\w*|treatment|medication|fit note|sick note|doctor's note|mental health|therapy|therapist|hiv status|immigration status|immigration case|visa|right to work|work permit|religion|faith|ethnicity|race|sexual orientation|gender identity|transition|criminal record|conviction|dbs check result)\\b`,
  ],
].map(([id, src]) => ({ id: id!, re: r(src!), reason: 'sensitive_personal' as const }));

const DECISION: Rule[] = [
  // "should I fire Tom", "can we dismiss her", "would you promote Alex" (not "can I be dismissed")
  { id: 'modal_decision', re: r(`\\b(?:should|shall|must|can|could|may|would|will) ${SUBJ}(?! be\\b| get\\b)${W(2)} ${DECISION_VERB}\\b`), reason: 'employment_decision' },
  // "should I give Priya a raise", "can we pay him more", "should I deny her bonus"
  { id: 'modal_award', re: r(`\\b(?:should|shall|can|could|would|will) ${SUBJ}(?! get\\b| receive\\b| be\\b)${W(2)} (?:give|award|offer|grant|pay|deny|withhold|refuse|reduce|increase|freeze|approve|reject|cut)\\b${W(4)} ${OUTCOME_THING}\\b`), reason: 'employment_decision' },
  // "who should we let go", "which candidate should we hire", "who deserves a promotion"
  {
    id: 'who_selection',
    re: r(`\\b(?:who|which (?:one|ones|employee|employees|candidate|candidates|applicant|applicants|person|people|team members?|worker|workers|staff member|of (?:them|these|those|my team|the team|the candidates|my staff|my reports|us)))\\b${W(6)} (?:should|shall|deserves?|ought|would you|do you think|to|will|gets?|is (?:the )?(?:best|worst|weakest|strongest|top|bottom))\\b${W(6)} ${TOPIC}\\b`),
    reason: 'employment_decision',
    unless: r(CONTACT),
  },
  // "rank my team by performance", "compare these candidates", "score the applicants"
  {
    id: 'rank_people',
    re: r(`\\b(?:rank|rate|score|grade|evaluate|assess|compare|shortlist|appraise|judge|benchmark|order|sort)\\b${W(6)} (?:employees?|staff|team|teams|team members|candidates?|applicants?|colleagues?|people|workers|direct reports|reports|cvs?|resumes?|performers?|hires|starters|members|interviewees)\\b`),
    reason: 'employment_decision',
  },
  { id: 'pick_people', re: r(`\\b(?:pick|choose|select|identify|recommend|nominate|name)\\b${W(3)} (?:the )?(?:best|worst|weakest|strongest|top|bottom|right|ideal|lowest|highest|least|most)\\b${W(3)} (?:employees?|staff|candidates?|applicants?|person|people|performers?|team members?|workers|hire|fit|one)\\b`), reason: 'employment_decision' },
  { id: 'pick_to_decide', re: r(`\\b(?:pick|choose|select|nominate|name)\\b${W(3)} (?:one|someone|somebody|a person|people|an employee|employees|staff|who|which)\\b${W(2)} to (?:${DECISION_VERB})\\b`), reason: 'employment_decision' },
  { id: 'best_worst_person', re: r(`\\b(?:best|worst|weakest|strongest|lowest|poorest|least productive|most productive|top|bottom)[ -](?:performing|performer|performers|candidate|candidates|applicant|applicants|employee|employees|hire|fit|worker|workers|team member|member of staff|contributor)\\b`), reason: 'employment_decision' },
  // "how much should I pay the new hire", "what salary should I offer", "what rating should Alex get"
  { id: 'how_much_pay', re: r(`\\bhow much (?:(?:of )?(?:a |an )?(?:raise|rise|pay rise|bonus|increase|salary|pay|money|compensation|commission|equity) )?(?:should|would|do you think|could|can|ought) ${SUBJ}${W(2)} (?:pay|offer|give|award|budget|raise|increase)\\b`), reason: 'employment_decision' },
  { id: 'how_much_for_other', re: r(`\\bhow much${W(3)} (?:raise|rise|bonus|increase|salary|pay|commission) (?:should|would|will|do you think) ${OTHER_SUBJ} (?:get|receive|be (?:given|paid|offered|awarded))\\b`), reason: 'employment_decision' },
  { id: 'what_amount_should', re: r(`\\bwhat${W(3)} (?:salary|pay|rate|raise|rise|bonus|rating|score|grade|band|increase|level|offer|package|figure|sanction|punishment|outcome|penalty|disciplinary action)s? (?:should|shall|would you|do you (?:recommend|suggest)|to (?:offer|give|pay|award|assign)|is (?:fair|appropriate|right) for)\\b`), reason: 'employment_decision' },
  // "is it fair to fire someone for lateness" (not "is it legal to be dismissed while…")
  { id: 'fairness_of_decision', re: r(`\\b(?:is|was|would|will) (?:it|this|that)${W(1)} (?:fair|ok|okay|alright|reasonable|justified|justifiable|legal|lawful|allowed|acceptable|right|wise|a good idea|too harsh|harsh|enough)${W(1)} (?:to|for (?:me|us|them|him|her|the company|my manager) to) (?:${DECISION_VERB}|cut|reduce|withhold|deny|refuse|give|pay|offer)\\b`), reason: 'employment_decision' },
  { id: 'grounds_to_dismiss', re: r(`\\b(?:reasons?|grounds|case|justification|evidence|excuse|way|ways|how)${W(1)} (?:to|for|i can|we can|i could|we could) (?:${DISMISS}|demote|discipline|reject|deny (?:\\w+ )?(?:a )?(?:raise|rise|bonus|promotion)|withhold)\\b`), reason: 'employment_decision' },
  // "should she be promoted", "should Tom get a warning"
  { id: 'should_other_be', re: r(`\\bshould ${OTHER_SUBJ}${W(2)} (?:be|get|receive) (?:fired|dismissed|sacked|promoted|demoted|disciplined|suspended|made redundant|laid off|let go|hired|rejected|terminated|paid (?:more|less)|(?:a |an )?(?:raise|rise|pay rise|bonus|promotion|warning|written warning|final warning|pay cut|increase|(?:the |a )?(?:job|role|offer|position)))\\b`), reason: 'employment_decision' },
  // "help me decide who to promote", "decide whether to fire"
  { id: 'help_decide', re: r(`\\b(?:help|assist|advise) (?:me|us)(?: to)? (?:decide|choose|pick|determine|work out|figure out|select|judge)\\b${W(8)} (?:${DECISION_VERB}|${TOPIC}|whether to|who|which)\\b`), reason: 'employment_decision' },
  { id: 'decide_whether', re: r(`\\b(?:decide|determine|choose|pick|select|work out)\\b${W(3)} (?:who|which${W(1)}|whether (?:to|or not to|we should|i should))\\b${W(6)} (?:${DECISION_VERB}|${TOPIC})\\b`), reason: 'employment_decision', unless: r(CONTACT) },
  // "score my team for redundancy", "put Sam in the redundancy pool"
  { id: 'redundancy_selection', re: r(`\\b(?:select|selecting|pick|picking|choose|choosing|score|scoring|rank|ranking|nominate|put|place|add|include|target)\\b${W(4)} (?:for|in|into|on) (?:the )?(?:redundancy|redundancies|layoffs?|lay-offs?|the cut|cuts|dismissal|exit)(?: pool| list)?\\b`), reason: 'employment_decision' },
  { id: 'who_would_you', re: r(`\\b(?:who|which one|which of them|which person|which employee|which candidate) would you${W(1)} (?:${DECISION_VERB}|pick|choose|select|keep|cut|reward|pay)\\b`), reason: 'employment_decision' },
  // "draft a dismissal letter for…", "write the warning letter for Sam"
  { id: 'draft_decision_letter', re: r(`\\b(?:draft|write|prepare|create|compose|generate|produce)\\b${W(3)} (?:dismissal|termination|redundancy|rejection|warning|disciplinary|demotion|sacking|firing|pay cut|suspension|final written)${W(2)} (?:letter|notice|email|message|decision|outcome|note)\\b`), reason: 'employment_decision' },
  { id: 'write_review_for', re: r(`\\b(?:write|draft|prepare|compose)\\b${W(3)} (?:performance review|appraisal|review|evaluation|feedback|reference|rating)s? (?:for|of|about) (?!myself\\b|me\\b)`), reason: 'employment_decision' },
  { id: 'assign_rating', re: r(`\\b(?:give|assign|award|set|put)\\b${W(3)} (?:a |an |the )?(?:performance )?(?:rating|score|grade|mark) (?:of|for|to)\\b`), reason: 'employment_decision' },
  // "is Sam a good employee", "is the candidate a good fit"
  { id: 'judge_person', re: r(`\\bis ${OTHER_SUBJ}${W(2)} (?:a |an )?(?:good|bad|poor|great|strong|weak|lazy|competent|incompetent|reliable|unreliable|right|wrong|safe|risky|better|worse)(?: [\\w-]+)? (?:employee|worker|performer|hire|fit|candidate|applicant|manager|colleague|team member|person|choice|bet)\\b`), reason: 'employment_decision' },
  { id: 'judge_person_trait', re: r(`\\bis ${OTHER_SUBJ} (?:lazy|incompetent|useless|hopeless|a liability|a problem|a troublemaker|underperforming|unreliable|any good|good enough|competent|capable enough|pulling (?:his|her|their) weight)\\b`), reason: 'employment_decision' },
  { id: 'push_out', re: r(`\\bhow (?:do|can|could|should|would) (?:i|we)${W(1)} (?:get rid of|push (?:[\\w'-]+ ){1,3}out|manage (?:[\\w'-]+ ){1,3}out|force (?:[\\w'-]+ ){1,3}out|ease (?:[\\w'-]+ ){1,3}out|edge (?:[\\w'-]+ ){1,3}out|make (?:him|her|them|[\\w'-]+) (?:leave|quit|resign))\\b`), reason: 'employment_decision' },
  { id: 'worth_keeping', re: r(`\\b(?:worth (?:keeping|hiring|promoting|retaining|firing|investing in)|(?:keep|retain) (?:him|her|them|[a-z]+) (?:on|or (?:fire|let|dismiss|sack)))\\b`), reason: 'employment_decision' },
  { id: 'cv_judgement', re: r(`\\b(?:cvs?|resumes?|applications?|cover letters?|interview (?:notes|answers|performance))\\b${W(8)} (?:best|worst|better|stronger|weaker|rank|score|rate|compare|shortlist|pick|choose|hire|reject)\\b`), reason: 'employment_decision' },
  { id: 'screen_cvs', re: r(`\\b(?:screen|filter|review|assess|evaluate|read)\\b${W(4)} (?:cvs?|resumes?|applications?|candidates?|applicants?)\\b${W(6)} (?:best|reject|shortlist|hire|interview|suitable|fit|strongest|weakest)\\b`), reason: 'employment_decision' },
  { id: 'disciplinary_against', re: r(`\\b(?:take|start|begin|open|launch|raise|bring|issue)\\b${W(1)} (?:disciplinary|formal)${W(1)} (?:action|proceedings|process|hearing|case|warning)s? (?:against|on|with|to) (?!me\\b|myself\\b)`), reason: 'employment_decision' },
  // hypotheticals and role-play around a decision: "if you were my manager, would you fire me?"
  { id: 'hypothetical_decision', re: r(`\\b(?:if you were|if you had to|if you (?:could|must|needed to)|imagine you(?: are|'re)|pretend you(?: are|'re)|hypothetically|in theory|just between us|off the record|as (?:a|the|my) (?:manager|hr manager|hr|boss|ceo|director|line manager))\\b${W(12)} (?:${DECISION_VERB}|${TOPIC})\\b`), reason: 'employment_decision' },
  { id: 'recommend_outcome', re: r(`\\b(?:recommend|suggest|advise (?:me|us)|your (?:advice|opinion|view|recommendation)|what do you think)\\b${W(6)} (?:(?:whether|who|which${W(1)}) to )?(?:${DECISION_VERB}|raise|rise|pay rise|bonus|salary|pay cut|increase|warning|sanction|rating|score|promotion|dismissal|termination|redundancy)\\b`), reason: 'employment_decision', unless: r(`${CONTACT}|\\bwho to (?:contact|ask|speak|talk|email|call)\\b`) },
];

const QUESTION_RULES: Rule[] = [...INJECTION, ...SENSITIVE, ...DECISION];

function firstMatch(rules: Rule[], text: string): Rule | undefined {
  return rules.find((rule) => rule.re.test(text) && !(rule.unless && rule.unless.test(text)));
}

/** Classifies a question. Pure and deterministic; the colleague check needs the directory (see redact.ts). */
export function guardQuestion(question: string): GuardResult {
  const s = normaliseQuestion(question);
  const hit = firstMatch(QUESTION_RULES, s);
  return hit ? { allowed: false, reason: hit.reason, rule: hit.id } : { allowed: true };
}

/** Topics that make a question about a named colleague a request for their personal data. */
export const COLLEAGUE_PERSONAL_TOPIC = r(
  `\\b(?:salary|salaries|pay|paid|earn|earns|earning|bonus|sick|sickness|ill|illness|health|medical|pregnan\\w*|disab\\w*|address|lives?|phone|number|email|performance|rating|disciplinary|warning|absence|absent|off work|leave balance|holiday balance|leaving|resign\\w*|fired|dismiss\\w*|redundan\\w*|visa|age|birthday|personal|private|record|records|review|appraisal|complaint|grievance|investigation|why)\\b`,
);

/**
 * Post-model check: the model must not have made or recommended a decision, whatever the excerpts
 * said. Returns the matching rule id, or undefined when the answer is acceptable.
 */
const ANSWER_RULES: Rule[] = [
  { id: 'answer_should_decide', re: r(`\\b(?:you|we|the company|management|your manager|i) (?:should|must|ought to|need to|could|can|may want to|might want to) (?:[\\w'-]+ ){0,2}(?:${DECISION_VERB}|give (?:[\\w'-]+ ){0,2}(?:a |an )?(?:raise|rise|bonus|warning|promotion|pay rise)|pay (?:[\\w'-]+ )?(?:more|less))\\b`), reason: 'employment_decision' },
  { id: 'answer_recommend', re: r(`\\bi (?:would )?(?:recommend|suggest|advise)\\b${W(6)} (?:firing|dismissing|dismissal|sacking|terminating|termination|hiring|rejecting|promoting|demoting|disciplining|suspending|a (?:raise|rise|bonus|warning|written warning|final warning|pay rise|promotion)|redundancy|letting [\\w'-]+ go|a salary of)\\b`), reason: 'employment_decision' },
  { id: 'answer_should_be', re: r(`\\b(?:should|deserves? to|ought to|needs to) be (?:fired|dismissed|sacked|promoted|demoted|disciplined|made redundant|let go|laid off|hired|rejected|suspended|terminated)\\b`), reason: 'employment_decision' },
  { id: 'answer_deserves', re: r(`\\b(?:deserves?|has earned|merits|is entitled to be given) (?:a |an )?(?:raise|rise|bonus|promotion|pay rise|warning|dismissal)\\b`), reason: 'employment_decision' },
  { id: 'answer_best_person', re: r(`\\b(?:the )?(?:best|strongest|weakest|worst) (?:candidate|performer|employee|applicant|choice) (?:is|would be|seems)\\b`), reason: 'employment_decision' },
  { id: 'answer_select', re: r(`\\b(?:select|choose|pick|nominate) (?:[\\w'-]+ ){0,2}for (?:redundancy|dismissal|promotion|the role|the job)\\b`), reason: 'employment_decision' },
  { id: 'answer_rating', re: r(`\\b(?:rate|rating|score) (?:him|her|them|this person|the employee) (?:as |at )?(?:a )?\\d\\b`), reason: 'employment_decision' },
];

export function guardAnswer(answer: string): string | undefined {
  const s = normaliseQuestion(answer);
  return firstMatch(ANSWER_RULES, s)?.id;
}

/** Excerpt text that looks like instructions to a model; such chunks are never sent (flagged at index time). */
export function looksLikeInjection(text: string): boolean {
  const s = normaliseQuestion(text);
  return (
    INJECTION.some((rule) => rule.id !== 'encoded_payload' && rule.re.test(s)) ||
    /\b(?:assistant|ai assistant|chatbot|chat bot|language model|llm|claude|gpt|ask hr)\b.{0,40}\b(?:must|should|shall|will|always|never)\b.{0,60}\b(?:recommend|tell|say|answer|reply|respond|advise|suggest|output)\b/i.test(s)
  );
}
