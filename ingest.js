import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ override: true }); // .env wins over leftover session variables

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY } = process.env;

const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'].filter(
  (name) => !process.env[name]
);
if (missing.length > 0) {
  console.error('Missing in .env:', missing.join(', '));
  process.exit(1);
}

const host = new URL(SUPABASE_URL.trim()).host;
console.log('Supabase host:', host);
if (host.startsWith('your-')) {
  console.error('SUPABASE_URL is still a placeholder.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL.trim(), SUPABASE_SERVICE_ROLE_KEY.trim());

const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// Smaller chunks so multi-sentence documents split into several chunks
const CHUNK_WORDS = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(vec) {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

async function embed(text, taskType = 'RETRIEVAL_DOCUMENT', attempt = 1) {
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY.trim(),
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: 768,
      }),
    });
    const data = await res.json();
    if (!data.embedding) throw new Error(JSON.stringify(data));
    return normalize(data.embedding.values);
  } catch (err) {
    if (attempt < 4) {
      console.warn(`Embedding attempt ${attempt} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return embed(text, taskType, attempt + 1);
    }
    throw err;
  }
}

function semanticChunker(text, maxWordsPerChunk = 300) {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  const chunks = [];
  let currentChunk = [];
  let currentWordCount = 0;

  for (const sentence of sentences) {
    const wordCount = sentence.trim().split(/\s+/).length;
    if (currentWordCount + wordCount > maxWordsPerChunk && currentChunk.length > 0) {
      chunks.push(currentChunk.join(' ').trim());
      const overlapSentence = currentChunk[currentChunk.length - 1];
      currentChunk = [overlapSentence];
      currentWordCount = overlapSentence.split(/\s+/).length;
    }
    currentChunk.push(sentence.trim());
    currentWordCount += wordCount;
  }
  if (currentChunk.length > 0) chunks.push(currentChunk.join(' ').trim());
  return chunks;
}

async function ingestDocument({ title, content, languageCode, metadata }) {
  // Duplicate guard: skip if this title is already stored
  const { data: existing, error: checkError } = await supabase
    .from('document_chunks')
    .select('id')
    .eq('document_title', title)
    .limit(1);

  if (checkError) {
    console.error(`Duplicate check failed for "${title}":`, checkError.message);
    return { status: 'failed', inserted: 0 };
  }
  if (existing && existing.length > 0) {
    console.log(`Skipping "${title}" (already ingested)`);
    return { status: 'skipped', inserted: 0 };
  }

  console.log(`Ingesting "${title}" [${languageCode}]`);
  const chunks = semanticChunker(content, CHUNK_WORDS);
  console.log(`${chunks.length} chunk(s)`);

  let inserted = 0;
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const embedding = await embed(chunks[i]);
    const { data, error } = await supabase
      .from('document_chunks')
      .insert({
        document_title: title,
        content: chunks[i],
        language_code: languageCode,
        embedding,
        metadata: { ...metadata, chunk_index: i },
      })
      .select('id');

    if (error) {
      failed++;
      console.error(`Chunk ${i} failed:`, error.message);
    } else {
      inserted++;
      console.log(`Chunk ${i + 1} inserted, id: ${data[0].id}`);
    }
    await sleep(400); // stay friendly to the Gemini rate limit
  }
  return { status: failed > 0 ? 'failed' : 'ingested', inserted };
}

const documents = [
  // ---- Original 5 documents (unchanged; skipped if already stored) ----
  {
    title: 'Constitutional Rights & Civic Access Guide',
    content:
      'Access to clean water, basic healthcare, and legal representation are foundational pillars of an equitable society. Under section 27 of the constitution, every citizen has the right to have access to health care services, sufficient food and water, and social security. Local municipalities are mandated to ensure transparent resource allocation and community consultation before executing public infrastructure projects.',
    languageCode: 'en',
    metadata: { category: 'civic_rights', source: 'public_policy_v2' },
  },
  {
    title: 'Housing Rights and Protection from Eviction',
    content:
      'Section 26 of the constitution gives everyone the right to have access to adequate housing. The state must take reasonable legislative and other measures, within its available resources, to achieve the progressive realisation of this right. No one may be evicted from their home, or have their home demolished, without an order of court made after considering all the relevant circumstances. Tenants who are threatened with removal should keep copies of their lease and any notices they receive.',
    languageCode: 'en',
    metadata: { category: 'housing', source: 'public_policy_v2' },
  },
  {
    title: 'Right to Education for Learners',
    content:
      'Section 29 of the constitution guarantees everyone the right to a basic education, including adult basic education, and to further education which the state must make progressively available and accessible. Learners also have the right to receive education in the official language or languages of their choice in public educational institutions where that education is reasonably practicable. Parents who are struggling to place a child in school can approach the provincial education department for assistance.',
    languageCode: 'en',
    metadata: { category: 'education', source: 'public_policy_v2' },
  },
  {
    title: 'Fair Labour Practices and Workers Rights',
    content:
      'Section 23 of the constitution states that everyone has the right to fair labour practices. Every worker has the right to form and join a trade union, to participate in the activities of a union, and to strike. Employers also have the right to form and join employers organisations. Workers who believe they were dismissed unfairly may refer a dispute to the Commission for Conciliation, Mediation and Arbitration within the prescribed time limit.',
    languageCode: 'en',
    metadata: { category: 'labour', source: 'public_policy_v2' },
  },
  {
    title: 'Access to Information Guide',
    content:
      'Section 32 of the constitution gives everyone the right of access to any information held by the state, and to any information held by another person that is required for the exercise or protection of any rights. National legislation sets out how requests must be made. A person who is refused information can lodge an internal appeal with the public body and later approach a court if the refusal stands.',
    languageCode: 'en',
    metadata: { category: 'information_access', source: 'public_policy_v2' },
  },

  // ---- New documents: plain-language summaries (verify against official text) ----
  {
    title: 'Equality and Protection from Unfair Discrimination',
    content:
      'Section 9 of the constitution says everyone is equal before the law and has the right to equal protection and benefit of the law. Neither the state nor any person may unfairly discriminate, directly or indirectly, against anyone on grounds such as race, gender, sex, pregnancy, marital status, ethnic or social origin, colour, sexual orientation, age, disability, religion, conscience, belief, culture, language or birth. Discrimination on one of these listed grounds is presumed to be unfair unless it is shown to be fair. The Promotion of Equality and Prevention of Unfair Discrimination Act gives effect to this right. A person who experiences discrimination can lodge a complaint with an Equality Court, which sits within the magistrates courts, and a complaint can be brought without a lawyer.',
    languageCode: 'en',
    metadata: { category: 'equality', source: 'plain_language_summary', reference: 'Constitution section 9; Promotion of Equality and Prevention of Unfair Discrimination Act 4 of 2000' },
  },
  {
    title: 'Human Dignity and the Right to Privacy',
    content:
      'Section 10 of the constitution says everyone has inherent dignity and the right to have their dignity respected and protected. Section 14 gives everyone the right to privacy. This includes the right not to have their person or home searched, not to have their property searched, not to have their possessions seized, and not to have the privacy of their communications infringed. A search of a person or home normally requires a warrant issued by a court. Any limit on these rights must be reasonable and justifiable in an open and democratic society. The Protection of Personal Information Act adds separate rules about how organisations may collect and use personal information.',
    languageCode: 'en',
    metadata: { category: 'dignity_privacy', source: 'plain_language_summary', reference: 'Constitution sections 10 and 14' },
  },
  {
    title: 'Freedom and Security of the Person',
    content:
      'Section 12 of the constitution protects the freedom and security of the person. Everyone has the right not to be deprived of freedom arbitrarily or without just cause, and not to be detained without trial. Everyone has the right to be free from all forms of violence from either public or private sources. No one may be tortured in any way, or treated or punished in a cruel, inhuman or degrading way. Everyone also has the right to bodily and psychological integrity, which includes the right to make decisions about reproduction and to security in and control over their body. No one may be subjected to medical or scientific experiments without their informed consent.',
    languageCode: 'en',
    metadata: { category: 'freedom_security', source: 'plain_language_summary', reference: 'Constitution section 12' },
  },
  {
    title: 'Freedom of Expression, Assembly and Association',
    content:
      'Section 16 of the constitution protects freedom of expression, including freedom of the press and other media, freedom to receive or impart information, freedom of artistic creativity and academic freedom. It does not extend to propaganda for war, incitement of imminent violence, or advocacy of hatred based on race, ethnicity, gender or religion that amounts to incitement to cause harm. Section 17 gives everyone the right to assemble, to demonstrate, to picket and to petition, peacefully and unarmed. Organisers of a gathering generally have to give notice to the local municipality under the Regulation of Gatherings Act. Section 18 gives everyone the right to freedom of association.',
    languageCode: 'en',
    metadata: { category: 'expression_assembly', source: 'plain_language_summary', reference: 'Constitution sections 16 to 18; Regulation of Gatherings Act 205 of 1993' },
  },
  {
    title: 'Right to Just Administrative Action',
    content:
      'Section 33 of the constitution says everyone has the right to administrative action that is lawful, reasonable and procedurally fair. Anyone whose rights have been adversely affected by administrative action has the right to be given written reasons. This covers decisions by government officials and bodies, such as a refused permit, a denied licence or a rejected application. The Promotion of Administrative Justice Act gives effect to this right and sets out how a decision can be reviewed by a court. A person who believes a decision was unfair should first ask the official or department for written reasons and use any internal appeal process before approaching a court.',
    languageCode: 'en',
    metadata: { category: 'administrative_justice', source: 'plain_language_summary', reference: 'Constitution section 33; Promotion of Administrative Justice Act 3 of 2000' },
  },
  {
    title: 'Access to Courts and the Right to a Fair Hearing',
    content:
      'Section 34 of the constitution gives everyone the right to have any dispute that can be resolved by the application of law decided in a fair public hearing before a court or, where appropriate, another independent and impartial tribunal or forum. This means no one should be shut out of the justice system because of who they are. Small disputes, such as claims for money owed or consumer complaints, can be taken to the magistrates courts or small claims courts. Some matters have their own specialised forums, such as the Labour Court, the Equality Court and rental housing tribunals. Courts are generally open to the public.',
    languageCode: 'en',
    metadata: { category: 'access_to_courts', source: 'plain_language_summary', reference: 'Constitution section 34' },
  },
  {
    title: 'Rights of Arrested, Detained and Accused Persons',
    content:
      'Section 35 of the constitution protects people who are arrested, detained or accused of a crime. An arrested person has the right to remain silent and must be told promptly of that right and the consequences of not remaining silent. No one may be compelled to make a confession. An arrested person must be brought before a court within 48 hours, or by the end of the first court day if the 48 hours end outside ordinary court hours or on a day that is not a court day. A detained person has the right to be told the reason for the detention and to consult a legal practitioner. The state must provide a lawyer at its expense if substantial injustice would otherwise result. Every accused person is presumed innocent and has the right to be released on bail unless the interests of justice require otherwise.',
    languageCode: 'en',
    metadata: { category: 'arrest_rights', source: 'plain_language_summary', reference: 'Constitution section 35' },
  },
  {
    title: 'Rights of Children',
    content:
      'Section 28 of the constitution sets out the rights of every child, meaning every person under the age of 18. Every child has the right to a name and a nationality from birth. Every child has the right to family care or parental care, or to appropriate alternative care when removed from the family environment. Children have the right to basic nutrition, shelter, basic health care services and social services. Children must be protected from maltreatment, neglect, abuse or degradation, and from exploitative labour. A child must not be required or permitted to perform work that is inappropriate for their age or that places their wellbeing, education or health at risk. A childs best interests are of paramount importance in every matter concerning the child.',
    languageCode: 'en',
    metadata: { category: 'children', source: 'plain_language_summary', reference: 'Constitution section 28' },
  },
  {
    title: 'Language and Cultural Rights',
    content:
      'Section 6 of the constitution recognises the official languages of the Republic, which include isiXhosa, isiZulu, Sesotho, Setswana, Sepedi, siSwati, Tshivenda, Xitsonga, isiNdebele, Afrikaans and English. South African Sign Language was added as an official language in 2023. The state must take practical and positive measures to elevate the status and advance the use of the indigenous languages. Section 30 gives everyone the right to use the language and to participate in the cultural life of their choice, and section 31 protects the right of cultural, religious and linguistic communities to enjoy their culture and practise their religion and language. Government departments should be able to communicate with the public in languages that people understand.',
    languageCode: 'en',
    metadata: { category: 'language_culture', source: 'plain_language_summary', reference: 'Constitution sections 6, 30 and 31' },
  },
  {
    title: 'Environmental Rights',
    content:
      'Section 24 of the constitution says everyone has the right to an environment that is not harmful to their health or wellbeing. It also gives everyone the right to have the environment protected, for the benefit of present and future generations, through reasonable legislative and other measures. These measures must prevent pollution and ecological degradation, promote conservation, and secure ecologically sustainable development and use of natural resources while promoting justifiable economic and social development. Communities affected by pollution, such as contaminated water, mine dust or illegal dumping, can report the problem to the municipality or the provincial environmental department and can ask for an environmental impact assessment where a new project is planned.',
    languageCode: 'en',
    metadata: { category: 'environment', source: 'plain_language_summary', reference: 'Constitution section 24' },
  },
  {
    title: 'Property and Land Rights',
    content:
      'Section 25 of the constitution protects property. No one may be deprived of property except in terms of a law of general application, and no law may permit arbitrary deprivation of property. Property may be expropriated only in terms of a law of general application, for a public purpose or in the public interest, and subject to compensation. The state must take reasonable measures, within its available resources, to foster conditions that enable citizens to gain access to land on an equitable basis. A person or community whose tenure of land is legally insecure because of past racially discriminatory laws or practices is entitled, to the extent provided by an Act of Parliament, either to tenure which is legally secure or to comparable redress.',
    languageCode: 'en',
    metadata: { category: 'property_land', source: 'plain_language_summary', reference: 'Constitution section 25' },
  },
  {
    title: 'Social Grants and How to Apply',
    content:
      'Section 27 of the constitution gives everyone the right to social security, including appropriate social assistance if they are unable to support themselves and their dependants. The South African Social Security Agency administers social grants under the Social Assistance Act. Common grants include the child support grant, the older persons grant, the disability grant, the foster child grant, the care dependency grant and the grant-in-aid. Applications are made at a SASSA office and the applicant must bring identity documents and proof of income and circumstances. If an application is refused, the applicant can ask SASSA to reconsider the decision within 90 days of being notified. If the refusal stands, an appeal can be lodged with the Independent Tribunal for Social Assistance Appeals.',
    languageCode: 'en',
    metadata: { category: 'social_grants', source: 'plain_language_summary', reference: 'Constitution section 27; Social Assistance Act 13 of 2004' },
  },
  {
    title: 'Domestic Violence and Protection Orders',
    content:
      'The Domestic Violence Act protects people in domestic relationships, including spouses, partners, family members, people who share a home and parents of a child. Domestic violence includes physical, sexual, emotional, verbal, psychological and economic abuse, as well as intimidation, harassment, stalking and damage to property. A victim can apply for a protection order at the magistrates court, and the clerk of the court must help the applicant complete the forms. There is no fee. The court can issue an interim protection order and attach a warning of arrest, so that the police can arrest the abuser if the order is broken. Police officers must help the victim find shelter and medical treatment. Breaking a protection order is a criminal offence.',
    languageCode: 'en',
    metadata: { category: 'domestic_violence', source: 'plain_language_summary', reference: 'Domestic Violence Act 116 of 1998' },
  },
  {
    title: 'Tenant Rights under the Rental Housing Act',
    content:
      'The Rental Housing Act regulates the relationship between landlords and tenants. A lease can be written or oral, but a written lease protects both sides. The landlord must give the tenant a written receipt for every payment made. A deposit must be held in an interest-bearing account, the interest belongs to the tenant, and the deposit must be refunded at the end of the lease less any lawful deductions for damage. The landlord and tenant should inspect the property together when the tenant moves in and again when the tenant moves out. A landlord may not lock a tenant out, cut off water or electricity, or remove belongings without a court order. Each province has a rental housing tribunal that resolves disputes between landlords and tenants.',
    languageCode: 'en',
    metadata: { category: 'rental', source: 'plain_language_summary', reference: 'Rental Housing Act 50 of 1999' },
  },
  {
    title: 'Illegal Eviction and the PIE Act',
    content:
      'The Prevention of Illegal Eviction from and Unlawful Occupation of Land Act, known as the PIE Act, makes it unlawful to evict anyone from their home without a court order. A landlord or owner who wants to evict must apply to court, and the occupier must be served with notice of the court proceedings at least 14 days before the hearing. The court must consider all the relevant circumstances, including the rights and needs of the elderly, children, disabled persons and households headed by women. The court may grant an eviction order only if it is just and equitable to do so, and it must set a date by which the occupier must leave. Changing the locks or removing a persons belongings without a court order is an illegal eviction.',
    languageCode: 'en',
    metadata: { category: 'eviction', source: 'plain_language_summary', reference: 'Prevention of Illegal Eviction from and Unlawful Occupation of Land Act 19 of 1998' },
  },
  {
    title: 'Unfair Dismissal and the CCMA',
    content:
      'The Labour Relations Act says a dismissal must be for a fair reason and follow a fair procedure. Fair reasons include misconduct, incapacity or poor performance, and the operational requirements of the employer, such as retrenchment. An employee who believes they were dismissed unfairly can refer the dispute to the Commission for Conciliation, Mediation and Arbitration, known as the CCMA, within 30 days of the dismissal. The CCMA does not charge a fee. The dispute first goes to conciliation and, if it is not resolved, to arbitration. Some dismissals are automatically unfair, for example a dismissal because of pregnancy, trade union activity or discrimination, and those disputes can go to the Labour Court.',
    languageCode: 'en',
    metadata: { category: 'dismissal', source: 'plain_language_summary', reference: 'Labour Relations Act 66 of 1995' },
  },
  {
    title: 'Working Hours, Leave and Basic Conditions of Employment',
    content:
      'The Basic Conditions of Employment Act sets minimum standards for most employees. Ordinary working hours may not exceed 45 hours in a week. Overtime must be agreed and is paid at one and a half times the normal wage. An employee is entitled to 21 consecutive days of paid annual leave each leave cycle. An employee may take up to 30 days of paid sick leave in a three year cycle. A pregnant employee is entitled to at least four consecutive months of maternity leave, and the employer is not required to pay during this leave, but the employee may claim benefits from the Unemployment Insurance Fund. An employer must give every employee written particulars of their employment, including pay and hours of work.',
    languageCode: 'en',
    metadata: { category: 'working_conditions', source: 'plain_language_summary', reference: 'Basic Conditions of Employment Act 75 of 1997' },
  },
  {
    title: 'Protection of Personal Information (POPIA)',
    content:
      'The Protection of Personal Information Act, known as POPIA, sets rules for how organisations collect, store, use and share personal information. It requires organisations to process information lawfully and to follow eight conditions, including accountability, purpose specification, information quality, openness and security safeguards. A person whose information is held by an organisation can ask the organisation to confirm whether it holds their information and can ask for it to be corrected or deleted. Organisations must notify the Information Regulator and the affected people if personal information is accessed or acquired without authorisation. A person who believes their information has been misused can lodge a complaint with the Information Regulator.',
    languageCode: 'en',
    metadata: { category: 'data_protection', source: 'plain_language_summary', reference: 'Protection of Personal Information Act 4 of 2013' },
  },
  {
    title: 'How to Make a PAIA Request for Information',
    content:
      'The Promotion of Access to Information Act, known as PAIA, sets out how to request records held by a public body or a private body. The request is made in writing, usually on the prescribed form, to the information officer of the body. The requester must describe the record clearly and say which form of access is wanted. A public body must decide on the request within 30 days, and it may extend this period by a further 30 days in certain circumstances. If the request is refused, the requester can lodge an internal appeal where the body is a department of national or provincial government. After that, or where there is no internal appeal, the requester can complain to the Information Regulator or apply to a court.',
    languageCode: 'en',
    metadata: { category: 'information_access', source: 'plain_language_summary', reference: 'Promotion of Access to Information Act 2 of 2000' },
  },
  {
    title: 'Free Legal Help and Complaint Bodies',
    content:
      'People who cannot afford a lawyer can get free legal help from Legal Aid South Africa, which provides legal representation in criminal matters and some civil matters, subject to a means test. University law clinics and community advice offices also give free advice. The Public Protector investigates complaints about maladministration and improper conduct by state bodies. The South African Human Rights Commission deals with complaints about human rights violations, and the Commission for Gender Equality deals with gender discrimination. A person with a complaint against the police can approach the Independent Police Investigative Directorate. These bodies are free to use and a complaint does not require a lawyer.',
    languageCode: 'en',
    metadata: { category: 'legal_help', source: 'plain_language_summary', reference: 'Legal Aid South Africa Act 39 of 2014; Constitution Chapter 9' },
  },
  {
    title: 'Child Maintenance and How to Claim It',
    content:
      'Under the Maintenance Act, both parents have a duty to support their children according to their means, whether or not they are married to each other. A parent or caregiver who needs maintenance can apply at the maintenance court at the magistrates court nearest to where the child lives. A lawyer is not required, and court staff help the applicant complete the forms. Maintenance investigators can help trace a parent who is avoiding payment and find out what that parent earns. The court can order regular payments and can order that the amount be deducted from the parents salary. A parent who fails to pay maintenance as ordered can face enforcement action, which can include a criminal charge.',
    languageCode: 'en',
    metadata: { category: 'maintenance', source: 'plain_language_summary', reference: 'Maintenance Act 99 of 1998' },
  },
];

const totals = { ingested: 0, skipped: 0, failed: 0, chunks: 0 };

for (const doc of documents) {
  const result = await ingestDocument(doc);
  totals[result.status]++;
  totals.chunks += result.inserted;
}

console.log('\n==== INGESTION SUMMARY ====');
console.log(`Documents in list:     ${documents.length}`);
console.log(`Newly ingested:        ${totals.ingested}`);
console.log(`Skipped (already in):  ${totals.skipped}`);
console.log(`Failed:                ${totals.failed}`);
console.log(`Chunks inserted:       ${totals.chunks}`);
console.log('Ingestion run complete.');