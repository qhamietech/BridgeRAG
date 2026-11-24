import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const env = (name) => (process.env[name] || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';
const EMBED_DIMS = 768;
const MIN_SIMILARITY = Number(process.env.MIN_SIMILARITY ?? 0.58);
const RELATIVE_GAP = Number(process.env.RELATIVE_GAP ?? 0.05);

// Exact guide titles matching ingest.js (1..26)
const GUIDE_TITLES = {
  1: 'Constitutional Rights & Civic Access Guide',
  2: 'Housing Rights and Protection from Eviction',
  3: 'Right to Education for Learners',
  4: 'Fair Labour Practices and Workers Rights',
  5: 'Access to Information Guide',
  6: 'Equality and Protection from Unfair Discrimination',
  7: 'Human Dignity and the Right to Privacy',
  8: 'Freedom and Security of the Person',
  9: 'Freedom of Expression, Assembly and Association',
  10: 'Right to Just Administrative Action',
  11: 'Access to Courts and the Right to a Fair Hearing',
  12: 'Rights of Arrested, Detained and Accused Persons',
  13: 'Rights of Children',
  14: 'Language and Cultural Rights',
  15: 'Environmental Rights',
  16: 'Property and Land Rights',
  17: 'Social Grants and How to Apply',
  18: 'Domestic Violence and Protection Orders',
  19: 'Tenant Rights under the Rental Housing Act',
  20: 'Illegal Eviction and the PIE Act',
  21: 'Unfair Dismissal and the CCMA',
  22: 'Working Hours, Leave and Basic Conditions of Employment',
  23: 'Protection of Personal Information (POPIA)',
  24: 'How to Make a PAIA Request for Information',
  25: 'Free Legal Help and Complaint Bodies',
  26: 'Child Maintenance and How to Claim It',
};

function normalize(vec) {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

async function embedQuery(text, attempt = 1) {
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env('GEMINI_API_KEY'),
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: 'RETRIEVAL_QUERY',
        outputDimensionality: EMBED_DIMS,
      }),
    });
    const data = await res.json();
    if (!data.embedding) throw new Error(JSON.stringify(data));
    return normalize(data.embedding.values);
  } catch (err) {
    if (attempt < 4) {
      await sleep(1000 * attempt);
      return embedQuery(text, attempt + 1);
    }
    throw err;
  }
}

function parseQuestions(targetSet) {
  const raw = fs.readFileSync(path.resolve('eval-questions.txt'), 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const [author, set, type, question, expected] = t.split('|').map((s) => s.trim());
    if (set.toLowerCase() !== targetSet) continue;
    const expectedTokens =
      expected.toUpperCase() === 'NONE'
        ? []
        : expected.split(',').map((tok) => tok.trim().toLowerCase());
    rows.push({
      author: author.toLowerCase(),
      set: set.toLowerCase(),
      type: type.toLowerCase(),
      question,
      expectedTokens,
    });
  }
  return rows;
}

function docMatchesToken(docTitle, token) {
  if (token.startsWith('s')) {
    return docTitle.toLowerCase().startsWith('constitution ' + token + ':');
  }
  const num = Number(token);
  const expectedTitle = GUIDE_TITLES[num];
  return expectedTitle ? docTitle.toLowerCase() === expectedTitle.toLowerCase() : false;
}

function applyFilters(rows) {
  const aboveMin = (rows || []).filter((r) => r.similarity >= MIN_SIMILARITY);
  const topScore = aboveMin.length > 0 ? Math.max(...aboveMin.map((r) => r.similarity)) : 0;
  return aboveMin.filter((r) => r.similarity >= topScore - RELATIVE_GAP);
}

async function runMode(mode, items) {
  let top1 = 0;
  let top3 = 0;
  let inDomainTotal = 0;
  let refusedCorrect = 0;
  let refuseTotal = 0;
  let lowestInDomainSim = 1.0;
  let highestRefuseSim = 0.0;
  const byType = {};
  const byAuthor = {};
  const failures = [];

  for (const item of items) {
    let rpcName = 'hybrid_search';
    let rpcArgs = { query_text: item.question, query_embedding: item.embedding, match_count: 5 };

    if (mode === 'pure_vector') {
      rpcName = 'vector_search';
      rpcArgs = { query_embedding: item.embedding, match_count: 5 };
    } else if (mode === 'weighted') {
      rpcName = 'weighted_search';
      rpcArgs = { query_text: item.question, query_embedding: item.embedding, match_count: 5 };
    }

    const { data, error } = await supabase.rpc(rpcName, rpcArgs);
    if (error) throw new Error(`${rpcName} failed: ${error.message}`);

    const kept = applyFilters(data);

    byType[item.type] = byType[item.type] || { pass: 0, total: 0 };
    byAuthor[item.author] = byAuthor[item.author] || { pass: 0, total: 0 };
    byType[item.type].total++;
    byAuthor[item.author].total++;

    if (item.type === 'refuse') {
      refuseTotal++;
      const topRawSim = data && data.length > 0 ? data[0].similarity : 0;
      if (topRawSim > highestRefuseSim) highestRefuseSim = topRawSim;
      if (kept.length === 0) {
        refusedCorrect++;
        byType[item.type].pass++;
        byAuthor[item.author].pass++;
      } else {
        failures.push(
          `  [REFUSE FAIL] (${item.author}) "${item.question}" -> kept "${kept[0].document_title}" (${kept[0].similarity.toFixed(3)})`
        );
      }
    } else {
      inDomainTotal++;
      if (kept.length > 0 && kept[0].similarity < lowestInDomainSim) {
        lowestInDomainSim = kept[0].similarity;
      }
      const top1Hit =
        kept.length > 0 && item.expectedTokens.some((tok) => docMatchesToken(kept[0].document_title, tok));
      const top3Hit = kept
        .slice(0, 3)
        .some((row) => item.expectedTokens.some((tok) => docMatchesToken(row.document_title, tok)));

      if (top1Hit) {
        top1++;
        byType[item.type].pass++;
        byAuthor[item.author].pass++;
      }
      if (top3Hit) top3++;

      if (!top1Hit) {
        const got =
          kept.length > 0 ? `${kept[0].document_title} (${kept[0].similarity.toFixed(3)})` : 'NONE (filtered out)';
        failures.push(
          `  [${item.type.toUpperCase()} MISS] (${item.author}) "${item.question}" -> expected [${item.expectedTokens.join(',')}], got ${got}`
        );
      }
    }
  }

  return {
    mode,
    top1,
    top3,
    inDomainTotal,
    refusedCorrect,
    refuseTotal,
    lowestInDomainSim,
    highestRefuseSim,
    byType,
    byAuthor,
    failures,
  };
}

const targetSet = process.argv.includes('--test') ? 'test' : 'dev';
const questions = parseQuestions(targetSet);
console.log(`Embedding ${questions.length} [${targetSet.toUpperCase()}] questions once (MIN_SIMILARITY=${MIN_SIMILARITY})...`);

for (const q of questions) {
  q.embedding = await embedQuery(q.question);
  await sleep(300);
}

for (const mode of ['pure_vector', 'weighted', 'hybrid_rrf']) {
  const res = await runMode(mode, questions);
  const totalPass = res.top1 + res.refusedCorrect;
  const totalCount = res.inDomainTotal + res.refuseTotal;
  console.log(`\n=== ${mode.toUpperCase()} (${targetSet.toUpperCase()}) ===`);
  console.log(`Overall Top-1 + Refusal: ${totalPass}/${totalCount} (${((totalPass / totalCount) * 100).toFixed(1)}%)`);
  console.log(`In-domain Top-1:         ${res.top1}/${res.inDomainTotal} (lowest top-1 sim: ${res.lowestInDomainSim.toFixed(3)})`);
  console.log(`In-domain Top-3 Recall:  ${res.top3}/${res.inDomainTotal}`);
  console.log(`Refusal Accuracy:        ${res.refusedCorrect}/${res.refuseTotal} (highest out-of-scope sim: ${res.highestRefuseSim.toFixed(3)})`);
  console.log(
    'By type:   ' +
      Object.entries(res.byType)
        .map(([k, v]) => `${k} ${v.pass}/${v.total}`)
        .join(' | ')
  );
  console.log(
    'By author: ' +
      Object.entries(res.byAuthor)
        .map(([k, v]) => `${k} ${v.pass}/${v.total}`)
        .join(' | ')
  );
  if (res.failures.length > 0) {
    console.log('Failures / Misses:');
    res.failures.forEach((f) => console.log(f));
  }
}
