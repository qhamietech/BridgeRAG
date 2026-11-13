import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const CHECK_ONLY = process.argv.includes('--check');
const FILE = path.resolve('corpus', 'constitution-ch2.txt');
const SOURCE_URL = 'https://www.gov.za/ts/documents/constitution/chapter-2-bill-rights';
const FIRST_SECTION = 7;
const LAST_SECTION = 39;
const CHUNK_WORDS = 120;

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY } = process.env;
let supabase = null;

if (!CHECK_ONLY) {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY'].filter(
    (name) => !process.env[name]
  );
  if (missing.length > 0) {
    console.error('Missing in .env:', missing.join(', '));
    process.exit(1);
  }
  supabase = createClient(SUPABASE_URL.trim(), SUPABASE_SERVICE_ROLE_KEY.trim());
}

if (!fs.existsSync(FILE)) {
  console.error(`File not found: ${FILE}`);
  process.exit(1);
}

const stat = fs.statSync(FILE);
const retrieved = stat.mtime.toISOString().slice(0, 10);

let raw = fs.readFileSync(FILE, 'utf8');
raw = raw.replace(/<[^>]*>/g, ' ');
raw = raw.replace(/\r/g, '').replace(/\u00a0/g, ' ');
const lines = raw.split('\n');

const LEAD_TITLES = { 7: 'rights', 8: 'application', 9: 'equality' };
const found = {};
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const re = n <= 9 
    ? new RegExp(`^\\s*${n}\\.\\s+${LEAD_TITLES[n]}`, 'i')
    : new RegExp(`(^|\\s)${n}\\.\\s+\\S`, 'i');
  lines.forEach((line, i) => {
    if (re.test(line)) found[n] = i;
  });
}

const notFound = [];
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) if (found[n] === undefined) notFound.push(n);
if (notFound.length > 0) {
  console.error(`Could not find the headings for sections: ${notFound.join(', ')}`);
  process.exit(1);
}

const sections = [];
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const start = found[n];
  let end = n < LAST_SECTION ? found[n + 1] : lines.length;
  if (n === LAST_SECTION) {
    const footer = lines.findIndex((l, i) => i > start && /^(related links|share this page|explore)\b/i.test(l.trim()));
    if (footer !== -1) end = footer;
  }
  const titleLine = lines[start].trim();
  const title = n <= 9 ? LEAD_TITLES[n] : titleLine.replace(new RegExp(`^.*?${n}\\.\\s+`), '');
  const body = lines
    .slice(start + 1, end)
    .map((l) => l.trim())
    .filter(Boolean);
  sections.push({ n, title, body, words: wordCount(body.join(' ')) });
}

function chunkLines(body, maxWords) {
  const chunks = [];
  let current = [];
  let count = 0;
  for (const line of body) {
    const w = wordCount(line);
    if (count + w > maxWords && current.length > 0) {
      chunks.push(current.join('\n'));
      const overlap = current[current.length - 1];
      current = [overlap];
      count = wordCount(overlap);
    }
    current.push(line);
    count += w;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

for (const s of sections) s.chunks = chunkLines(s.body, CHUNK_WORDS);

console.log(`\nSource file: ${FILE}  (saved ${retrieved})`);
console.log('Section  Words  Chunks  Title');
for (const s of sections) {
  console.log(`${String(s.n).padStart(7)}  ${String(s.words).padStart(5)}  ${String(s.chunks.length).padStart(6)}  ${s.title}`);
}
const totalWords = sections.reduce((a, s) => a + s.words, 0);
const totalChunks = sections.reduce((a, s) => a + s.chunks.length, 0);
console.log(`\nSections: ${sections.length}   Words: ${totalWords}   Chunks: ${totalChunks}`);

if (CHECK_ONLY) {
  console.log('\nCheck complete. Nothing was written to the database.');
  process.exit(0);
}

// ---------- Embedding and storing ----------
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
      await sleep(2000 * attempt);
      return embed(text, taskType, attempt + 1);
    }
    throw err;
  }
}

const totals = { ingested: 0, skipped: 0, failed: 0, chunks: 0 };

for (const s of sections) {
  const documentTitle = `Constitution s${s.n}: ${s.title}`;
  const { data: existing, error: checkError } = await supabase
    .from('document_chunks')
    .select('id')
    .eq('document_title', documentTitle)
    .limit(1);

  if (checkError) {
    totals.failed++;
    continue;
  }
  if (existing && existing.length > 0) {
    totals.skipped++;
    continue;
  }

  console.log(`Ingesting "${documentTitle}" (${s.chunks.length} chunk(s))`);
  let failed = 0;
  for (let i = 0; i < s.chunks.length; i++) {
    const content = `Constitution, section ${s.n} (${s.title}): ${s.chunks[i]}`;
    const embedding = await embed(content);
    const { error } = await supabase.from('document_chunks').insert({
      document_title: documentTitle,
      content,
      language_code: 'en',
      embedding,
      metadata: {
        category: 'constitution',
        source: 'official_text',
        reference: `Constitution of the Republic of South Africa, 1996, section ${s.n} (${s.title})`,
        section: s.n,
        url: SOURCE_URL,
        retrieved,
        chunk_index: i,
      },
    });
    if (error) failed++;
    else totals.chunks++;
    await sleep(400);
  }
  if (failed > 0) totals.failed++;
  else totals.ingested++;
}

console.log('\n==== CONSTITUTION INGESTION SUMMARY ====');
console.log(`Newly ingested:       ${totals.ingested}`);
console.log(`Skipped (already in): ${totals.skipped}`);
console.log(`Failed:               ${totals.failed}`);
console.log(`Chunks inserted:      ${totals.chunks}`);
console.log('Done.');
