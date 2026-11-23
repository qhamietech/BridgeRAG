import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config({ override: true }); // .env wins over leftover session variables

// Usage:
//   node ingest-constitution.js --check   (parse only: no embeddings, no database writes)
//   node ingest-constitution.js           (parse, embed and store)
const CHECK_ONLY = process.argv.includes('--check');

const FILE = path.resolve('corpus', 'constitution-ch2.txt');
const SOURCE_URL = 'https://www.gov.za/ts/documents/constitution/chapter-2-bill-rights';
const FIRST_SECTION = 7;
const LAST_SECTION = 39;
const CHUNK_WORDS = 120;

// Known typographic glitches in the web copy (each one is a pure spacing error)
const CLEANUPS = [[/\bof ficial\b/g, 'official']];

const EMBED_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

// ---------- Environment (only needed for a real run) ----------

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

// ---------- Converting a saved web page (HTML) to plain text ----------

const NAMED_ENTITIES = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '-',
  mdash: '-',
  lsquo: "'",
  rsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function htmlToText(html) {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div|ul|ol|table|nav|aside|article|section|header|footer)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => (NAMED_ENTITIES[name.toLowerCase()] ?? m))
    .replace(/&amp;/gi, '&');
}

// ---------- Parsing ----------

if (!fs.existsSync(FILE)) {
  console.error(`File not found: ${FILE}`);
  console.error('Create corpus\\constitution-ch2.txt and paste the page text or page source into it.');
  process.exit(1);
}

const stat = fs.statSync(FILE);
const retrieved = stat.mtime.toISOString().slice(0, 10);

let raw = fs.readFileSync(FILE, 'utf8');
const looksLikeHtml = /<\/?(html|body|div|p|h2)\b/i.test(raw);
if (looksLikeHtml) raw = htmlToText(raw);
console.log(`Input format: ${looksLikeHtml ? 'web page source (HTML, converted to text)' : 'plain text'}`);

raw = raw.replace(/\r/g, '').replace(/\u00ad/g, '').replace(/\u00a0/g, ' ');
for (const [pattern, replacement] of CLEANUPS) raw = raw.replace(pattern, replacement);
const lines = raw.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim());

// Sections 7 to 9 are found by their exact title, because subsections 7 to 9 of
// section 25 also start with "7." to "9.". Every later section is found by its number.
const LEAD_TITLES = { 7: 'rights', 8: 'application', 9: 'equality' };

const found = {};
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const re =
    n <= 9
      ? new RegExp(`^${n}\\.\\s+${LEAD_TITLES[n]}$`, 'i')
      : new RegExp(`^${n}\\.\\s+\\S`);
  // If the text has a table of contents with numbers, the real heading comes second, so keep the LAST match
  lines.forEach((line, i) => {
    if (re.test(line)) found[n] = i;
  });
}

const notFound = [];
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) if (found[n] === undefined) notFound.push(n);
if (notFound.length > 0) {
  console.error(`Could not find the headings for sections: ${notFound.join(', ')}`);
  console.error('Check that the whole page was saved into corpus\\constitution-ch2.txt');
  process.exit(1);
}
for (let n = FIRST_SECTION + 1; n <= LAST_SECTION; n++) {
  if (found[n] <= found[n - 1]) {
    console.error(`Section ${n} heading was found before section ${n - 1}. The file is out of order.`);
    process.exit(1);
  }
}

const sections = [];
for (let n = FIRST_SECTION; n <= LAST_SECTION; n++) {
  const start = found[n];
  let end = n < LAST_SECTION ? found[n + 1] : lines.length;
  if (n === LAST_SECTION) {
    // Cut the page footer that follows the last section
    const footer = lines.findIndex(
      (l, i) => i > start && /^(related links|share this page|explore)\b/i.test(l)
    );
    if (footer !== -1) end = footer;
  }
  const title = lines[start].replace(/^\d+\.\s+/, '');
  const body = lines.slice(start + 1, end).filter(Boolean);
  sections.push({ n, title, body, words: wordCount(body.join(' ')) });
}

// ---------- Chunking: groups of lines up to CHUNK_WORDS, one line of overlap ----------

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

// ---------- Report ----------

console.log(`\nSource file: ${FILE}  (saved ${retrieved})`);
console.log('Section  Words  Chunks  Title');
for (const s of sections) {
  console.log(
    `${String(s.n).padStart(7)}  ${String(s.words).padStart(5)}  ${String(s.chunks.length).padStart(6)}  ${s.title}`
  );
}
const totalWords = sections.reduce((a, s) => a + s.words, 0);
const totalChunks = sections.reduce((a, s) => a + s.chunks.length, 0);
console.log(`\nSections: ${sections.length}   Words: ${totalWords}   Chunks: ${totalChunks}`);

const tooShort = sections.filter((s) => s.words < 5);
if (tooShort.length > 0) {
  console.error(`Sections with almost no text: ${tooShort.map((s) => s.n).join(', ')}`);
  process.exit(1);
}
if (totalWords < 3500) {
  console.warn('WARNING: fewer words than expected for Chapter 2. Check the saved text is complete.');
}

if (CHECK_ONLY) {
  const s26 = sections.find((s) => s.n === 26);
  console.log('\nSample, first chunk of section 26:');
  console.log(s26.chunks[0].slice(0, 300));
  const s39 = sections.find((s) => s.n === 39);
  console.log('\nSample, last line of section 39 (should be a rights sentence, not page footer text):');
  console.log(s39.body[s39.body.length - 1].slice(0, 200));
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
      console.warn(`Embedding attempt ${attempt} failed, retrying...`);
      await sleep(2000 * attempt);
      return embed(text, taskType, attempt + 1);
    }
    throw err;
  }
}

const totals = { ingested: 0, skipped: 0, failed: 0, chunks: 0 };

for (const s of sections) {
  const documentTitle = `Constitution s${s.n}: ${s.title}`;

  // Duplicate guard: skip if this title is already stored
  const { data: existing, error: checkError } = await supabase
    .from('document_chunks')
    .select('id')
    .eq('document_title', documentTitle)
    .limit(1);

  if (checkError) {
    console.error(`Duplicate check failed for "${documentTitle}":`, checkError.message);
    totals.failed++;
    continue;
  }
  if (existing && existing.length > 0) {
    console.log(`Skipping "${documentTitle}" (already ingested)`);
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
    if (error) {
      failed++;
      console.error(`  Chunk ${i} failed:`, error.message);
    } else {
      totals.chunks++;
    }
    await sleep(400); // stay friendly to the Gemini rate limit
  }
  if (failed > 0) totals.failed++;
  else totals.ingested++;
}

console.log('\n==== CONSTITUTION INGESTION SUMMARY ====');
console.log(`Sections in file:     ${sections.length}`);
console.log(`Newly ingested:       ${totals.ingested}`);
console.log(`Skipped (already in): ${totals.skipped}`);
console.log(`Failed:               ${totals.failed}`);
console.log(`Chunks inserted:      ${totals.chunks}`);
console.log('Done.');