const API_URL = process.env.API_URL || 'http://localhost:3000/api/search';

const TITLES = {
  rights: 'Constitutional Rights & Civic Access Guide',
  housing: 'Housing Rights and Protection from Eviction',
  education: 'Right to Education for Learners',
  labour: 'Fair Labour Practices and Workers Rights',
  info: 'Access to Information Guide',
  grants: 'Social Grants and How to Apply',
  pie: 'Illegal Eviction and the PIE Act',
  rental: 'Tenant Rights under the Rental Housing Act',
  dismissal: 'Unfair Dismissal and the CCMA',
  paia: 'How to Make a PAIA Request for Information',
  domestic: 'Domestic Violence and Protection Orders',
  maintenance: 'Child Maintenance and How to Claim It',
  bcea: 'Working Hours, Leave and Basic Conditions of Employment',
  arrest: 'Rights of Arrested, Detained and Accused Persons',
  environment: 'Environmental Rights',
  legalHelp: 'Free Legal Help and Complaint Bodies',
  popia: 'Protection of Personal Information (POPIA)',
};

// accept: documents that count as a correct first result. The FIRST title is the
// primary expected document. Extra titles are allowed only when that document's
// text genuinely answers the question. null = nothing should be returned.
const TESTS = [
  { query: 'right to healthcare', accept: [TITLES.rights] },
  { query: 'can I get medical treatment if I am poor', accept: [TITLES.rights] },
  { query: 'is access to clean water a constitutional right', accept: [TITLES.rights] },
  { query: 'social security grants for citizens', accept: [TITLES.grants, TITLES.rights] },

  { query: 'my landlord wants to kick me out', accept: [TITLES.housing, TITLES.pie] },
  { query: 'can the municipality demolish my house', accept: [TITLES.housing] },
  { query: 'what documents should a tenant keep', accept: [TITLES.housing, TITLES.rental] },
  { query: 'right to adequate housing', accept: [TITLES.housing] },

  { query: 'my child cannot get a place at school', accept: [TITLES.education] },
  { query: 'can I be taught in my home language', accept: [TITLES.education] },
  { query: 'adult basic education rights', accept: [TITLES.education] },

  { query: 'I was fired unfairly', accept: [TITLES.dismissal, TITLES.labour] },
  { query: 'can workers go on strike', accept: [TITLES.labour] },
  { query: 'how do I join a trade union', accept: [TITLES.labour] },

  { query: 'how do I request a government document', accept: [TITLES.paia, TITLES.info] },
  { query: 'the public body refused to give me information', accept: [TITLES.info] },

  // Coverage checks for the new documents
  { query: 'my partner hits me and I want a protection order', accept: [TITLES.domestic] },
  { query: 'the father of my child does not pay support', accept: [TITLES.maintenance] },
  { query: 'how long do I have to take my dismissal to the CCMA', accept: [TITLES.dismissal] },
  { query: 'how many days of annual leave am I entitled to', accept: [TITLES.bcea] },
  { query: 'police arrested me what are my rights', accept: [TITLES.arrest] },
  { query: 'the factory is polluting our river', accept: [TITLES.environment] },
  { query: 'I cannot afford a lawyer', accept: [TITLES.legalHelp] },
  { query: 'a company leaked my personal information', accept: [TITLES.popia] },

  { query: 'best pizza recipe', accept: null },
  { query: 'who won the soccer match yesterday', accept: null },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let passedViaAlternative = 0;
let wrongDoc = 0;
let tooStrict = 0;
let falseHits = 0;
let relevantTotal = 0;
let offTopicTotal = 0;

for (const t of TESTS) {
  let r;
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: t.query, matchCount: 5 }),
    });
    r = await res.json();
  } catch (err) {
    console.error('Cannot reach the API. Is "node server.js" running?', err.message);
    process.exit(1);
  }

  if (r.error) {
    console.log(`ERROR  | ${t.query} -> ${r.error}`);
    continue;
  }

  const top = r.results && r.results[0];
  const topTitle = top ? top.document_title : null;
  const score = top ? top.similarity.toFixed(3) : '-';

  if (t.accept === null) {
    offTopicTotal++;
    if (!top) {
      passed++;
      console.log(`PASS   | ${t.query} -> nothing returned (correct)`);
    } else {
      falseHits++;
      console.log(`FAIL   | ${t.query} -> returned "${topTitle}" (${score}), expected nothing`);
    }
  } else {
    relevantTotal++;
    if (topTitle === t.accept[0]) {
      passed++;
      console.log(`PASS   | ${t.query} -> ${topTitle} (${score})`);
    } else if (topTitle && t.accept.includes(topTitle)) {
      passed++;
      passedViaAlternative++;
      console.log(`PASS*  | ${t.query} -> ${topTitle} (${score}) [accepted alternative]`);
    } else if (!top) {
      tooStrict++;
      console.log(`MISS   | ${t.query} -> nothing returned, filters too strict (expected "${t.accept[0]}")`);
    } else {
      wrongDoc++;
      console.log(`FAIL   | ${t.query} -> "${topTitle}" (${score}), expected "${t.accept[0]}"`);
    }
  }

  await sleep(500); // stay friendly to the Gemini rate limit
}

console.log('\n==== SUMMARY ====');
console.log(`Total queries:             ${TESTS.length}`);
console.log(`Passed:                    ${passed}`);
console.log(`  of which via alternative:${passedViaAlternative}`);
console.log(`Wrong document first:      ${wrongDoc}`);
console.log(`Filtered out (too strict): ${tooStrict}`);
console.log(`Off-topic false hits:      ${falseHits}`);
console.log(`Top-1 accuracy (relevant): ${relevantTotal - wrongDoc - tooStrict}/${relevantTotal}`);
console.log(`Off-topic rejected:        ${offTopicTotal - falseHits}/${offTopicTotal}`);