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

function normalize(vec) {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / mag);
}

async function embedQuery(text, attempt = 1) {
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') },
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

function parseQuestions() {
  const raw = fs.readFileSync(path.resolve('eval-questions-xh.txt'), 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split('|').map((s) => s.trim());
    if (parts.length !== 5) {
      console.error('Bad line (need 5 parts): ' + t);
      process.exit(1);
    }
    const [author, set, type, question, expected] = parts;
    rows.push({
      author: author.toLowerCase(),
      set: set.toLowerCase(),
      type: type.toLowerCase(),
      question,
      expectedTokens:
        expected.toUpperCase() === 'NONE' ? [] : expected.split(',').map((x) => x.trim().toLowerCase()),
    });
  }
  return rows;
}

// XH = right section in isiXhosa, EN_SAME = right section but the English text, MISS = anything else
function classify(title, tokens) {
  const t = title.toLowerCase();
  for (const tok of tokens) if (t.startsWith('constitution (xh) ' + tok + ':')) return 'XH';
  for (const tok of tokens) if (t.startsWith('constitution ' + tok + ':')) return 'EN_SAME';
  return 'MISS';
}

function shortTitle(title) {
  const m = title.match(/^Constitution (\(xh\) )?s(\d+):/);
  if (m) return (m[1] ? 'xh-s' : 'en-s') + m[2];
  return title;
}

function applyFilters(rows) {
  const aboveMin = (rows || []).filter((r) => r.similarity >= MIN_SIMILARITY);
  const topScore = aboveMin.length > 0 ? Math.max(...aboveMin.map((r) => r.similarity)) : 0;
  return aboveMin.filter((r) => r.similarity >= topScore - RELATIVE_GAP);
}

async function search(mode, item) {
  const rpc = mode === 'pure_vector' ? 'vector_search' : 'hybrid_search';
  const args =
    mode === 'pure_vector'
      ? { query_embedding: item.embedding, match_count: 5 }
      : { query_text: item.question, query_embedding: item.embedding, match_count: 5 };
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) throw new Error(rpc + ' failed: ' + error.message);
  return data || [];
}

const questions = parseQuestions();
console.log('Embedding ' + questions.length + ' isiXhosa questions once (MIN_SIMILARITY=' + MIN_SIMILARITY + ')...');
for (const q of questions) {
  q.embedding = await embedQuery(q.question);
  await sleep(300);
}

for (const mode of ['hybrid_rrf', 'pure_vector']) {
  console.log('\n=== ' + mode.toUpperCase() + ' ===');
  const tally = { inDomain: 0, top1Xh: 0, top1EnSame: 0, top3Xh: 0, refuseTotal: 0, refuseAtRetrieval: 0 };

  for (let i = 0; i < questions.length; i++) {
    const item = questions[i];
    const raw = await search(mode, item);
    const kept = applyFilters(raw);
    const label = 'Q' + (i + 1) + ' [' + item.type + '] expected ' + (item.expectedTokens.join(',') || 'NONE');

    if (item.type === 'refuse') {
      tally.refuseTotal++;
      const topRaw = raw.length > 0 ? Math.max(...raw.map((r) => r.similarity)) : 0;
      if (kept.length === 0) {
        tally.refuseAtRetrieval++;
        console.log(label + ' -> stopped at retrieval (top raw sim ' + topRaw.toFixed(3) + ')');
      } else {
        console.log(
          label + ' -> passed retrieval: ' + shortTitle(kept[0].document_title) +
            ' (' + kept[0].similarity.toFixed(3) + '), the model must refuse it'
        );
      }
      continue;
    }

    tally.inDomain++;
    const top = kept[0];
    const outcome = top ? classify(top.document_title, item.expectedTokens) : 'FILTERED';
    if (outcome === 'XH') tally.top1Xh++;
    if (outcome === 'EN_SAME') tally.top1EnSame++;
    const top3 = kept.slice(0, 3);
    if (top3.some((r) => classify(r.document_title, item.expectedTokens) === 'XH')) tally.top3Xh++;
    console.log(
      label + ' -> ' + outcome + ' | top1: ' +
        (top ? shortTitle(top.document_title) + ' (' + top.similarity.toFixed(3) + ')' : 'none') +
        ' | top3: ' + top3.map((r) => shortTitle(r.document_title)).join(', ')
    );
  }

  console.log('\nQuestions answerable from Chapter 2: ' + tally.inDomain);
  console.log('  Top-1 is the right isiXhosa section:       ' + tally.top1Xh + '/' + tally.inDomain);
  console.log('  Top-1 is the right section but in English: ' + tally.top1EnSame);
  console.log('  Right isiXhosa section in top 3:           ' + tally.top3Xh + '/' + tally.inDomain);
  console.log('Out-of-scope stopped at retrieval:           ' + tally.refuseAtRetrieval + '/' + tally.refuseTotal);
}
