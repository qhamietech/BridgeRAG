import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// Usage:
//   node ingest-constitution-xh.js --check   (parse only: no embeddings, no database writes)
//   node ingest-constitution-xh.js           (parse, embed and store)
const CHECK_ONLY = process.argv.includes('--check');
const FILE = path.resolve('corpus', 'constitution-ch2-xh.txt');
const SOURCE_URL = 'https://myconstitution.co.za/xh/02.html';
const FIRST_SECTION = 7;
const LAST_SECTION = 39;
const CHUNK_WORDS = 120;
const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

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
  console.log('Supabase host:', new URL(SUPABASE_URL.trim()).host);
  supabase = createClient(SUPABASE_URL.trim(), SUPABASE_SERVICE_ROLE_KEY.trim());
}

if (!fs.existsSync(FILE)) {
  console.error('File not found: ' + FILE);
  process.exit(1);
}

const stat = fs.statSync(FILE);
const retrieved = stat.mtime.toISOString().slice(0, 10);

let raw = fs.readFileSync(FILE, 'utf8');
raw = raw.replace(/\r/g, '').replace(/\u00ad/g, '').replace(/\u00a0/g, ' ');
const lines = raw.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());

// Sections 7 to 9 are matched by exact title, because numbered sub-items 1 to 9
// inside other sections also start with "7." to "9.".
const LEAD_TITLES = {
  7: '^7\\.\\s+Amalungelo$',
  8: '^8\\.\\s+Ukusebenza kwawo$',
  9: '^9\\.\\s+Ukulingana$',
};

// Find each heading IN ORDER, searching only after the previous heading.
// This stops numbered sub-items (for example items 10 to 15 inside section 35)
// from being mistaken for section headings.
const found = {};
let searchFrom = 0;
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const re = n <= 9 ? new RegExp(LEAD_TITLES[n]) : new RegExp('^' + n + '\\.\\s+\\S');
  let idx = -1;
  for (let i = searchFrom; i < lines.length; i++) {
    if (re.test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    console.error('Could not find the heading for section ' + n + ' after line ' + searchFrom);
    process.exit(1);
  }
  found[n] = idx;
  searchFrom = idx + 1;
}

const sections = [];
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const start = found[n];
  let end = n < LAST_SECTION ? found[n + 1] : lines.length;
  if (n === LAST_SECTION) {
    const footer = lines.findIndex((l, i) => i > start && /^Home\s+UMgaqo-siseko/i.test(l));
    if (footer !== -1) end = footer;
  }
  const title = lines[start].replace(/^\d+\.\s+/, '');
  const body = lines.slice(start + 1, end).filter(Boolean);
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

console.log('\nSource file: ' + FILE + '  (saved ' + retrieved + ')');
console.log('Section  Words  Chunks  Title');
for (const s of sections) {
  console.log(
    String(s.n).padStart(7) + '  ' + String(s.words).padStart(5) + '  ' +
      String(s.chunks.length).padStart(6) + '  ' + s.title
  );
}
const totalWords = sections.reduce((a, s) => a + s.words, 0);
const totalChunks = sections.reduce((a, s) => a + s.chunks.length, 0);
console.log('\nSections: ' + sections.length + '   Words: ' + totalWords + '   Chunks: ' + totalChunks);

const tooShort = sections.filter((s) => s.words < 3);
if (tooShort.length > 0) {
  console.error('Sections with almost no text: ' + tooShort.map((s) => s.n).join(', '));
  process.exit(1);
}

if (CHECK_ONLY) {
  const s26 = sections.find((s) => s.n === 26);
  console.log('\nSample, first chunk of section 26 (Izindlu):');
  console.log(s26.chunks[0]);
  const s35 = sections.find((s) => s.n === 35);
  console.log('\nSection 35 first line (should be subsection 1, not item 15):');
  console.log(s35.body[0].slice(0, 120));
  const s39 = sections.find((s) => s.n === 39);
  console.log('\nSample, last line of section 39 (should be a rights sentence, not the Home footer):');
  console.log(s39.body[s39.body.length - 1].slice(0, 200));
  console.log('\nCheck complete. Nothing was written to the database.');
  process.exit(0);
}

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
      console.warn('Embedding attempt ' + attempt + ' failed, retrying...');
      await sleep(2000 * attempt);
      return embed(text, taskType, attempt + 1);
    }
    throw err;
  }
}

const totals = { ingested: 0, skipped: 0, failed: 0, chunks: 0 };

for (const s of sections) {
  const documentTitle = 'Constitution (xh) s' + s.n + ': ' + s.title;

  const { data: existing, error: checkError } = await supabase
    .from('document_chunks')
    .select('id')
    .eq('document_title', documentTitle)
    .limit(1);

  if (checkError) {
    console.error('Duplicate check failed for "' + documentTitle + '":', checkError.message);
    totals.failed++;
    continue;
  }
  if (existing && existing.length > 0) {
    console.log('Skipping "' + documentTitle + '" (already ingested)');
    totals.skipped++;
    continue;
  }

  console.log('Ingesting "' + documentTitle + '" (' + s.chunks.length + ' chunk(s))');
  let failed = 0;
  for (let i = 0; i < s.chunks.length; i++) {
    const content = 'UMgaqo-siseko, icandelo ' + s.n + ' (' + s.title + '): ' + s.chunks[i];
    const embedding = await embed(content);
    const { error } = await supabase.from('document_chunks').insert({
      document_title: documentTitle,
      content,
      language_code: 'xh',
      embedding,
      metadata: {
        category: 'constitution',
        source: 'official_text',
        language: 'xh',
        reference:
          'UMgaqo-siseko weRiphablikhi yoMzantsi-Afrika, 1996, icandelo ' + s.n + ' (' + s.title + ')',
        section: s.n,
        url: SOURCE_URL,
        retrieved,
        chunk_index: i,
      },
    });
    if (error) {
      failed++;
      console.error('  Chunk ' + i + ' failed:', error.message);
    } else {
      totals.chunks++;
    }
    await sleep(400);
  }
  if (failed > 0) totals.failed++;
  else totals.ingested++;
}

console.log('\n==== XHOSA CONSTITUTION INGESTION SUMMARY ====');
console.log('Sections in file:     ' + sections.length);
console.log('Newly ingested:       ' + totals.ingested);
console.log('Skipped (already in): ' + totals.skipped);
console.log('Failed:               ' + totals.failed);
console.log('Chunks inserted:      ' + totals.chunks);
console.log('Done.');
