import {
  retrieve,
  generateAnswer,
  rejectIfLimited,
  reserveGeneration,
  getSectionChunks,
  LIMITS,
  SearchError,
  GEN_MODELS,
  MIN_SIMILARITY,
  RELATIVE_GAP,
  MAX_QUESTION_LENGTH,
  DISCLAIMER,
} from '../lib/rag.js';

// Sentences shown above the passages when no model-written answer is given.
// The isiXhosa versions are empty on purpose: the project author should write them.
// Until then the English sentence is shown.
const MESSAGES = {
  en: {
    official: 'Here is the official text of the section you asked about.',
    unavailable:
      'I cannot write an explanation right now. These are the passages that best match your question, but they may not answer it, so read them carefully.',
  },
  xh: {
    official: '',
    unavailable: '',
  },
};

function message(lang, key) {
  return (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key];
}

// Describes what retrieval found, for the "How this answer was found" panel
function retrievalSummary(candidates, kept) {
  const keptIds = new Set(kept.map((k) => k.id));
  return {
    minSimilarity: MIN_SIMILARITY,
    relativeGap: RELATIVE_GAP,
    candidates: candidates.map((c) => ({
      document_title: c.document_title,
      chunk_index: c.metadata?.chunk_index,
      similarity: c.similarity,
      kept: keptIds.has(c.id),
    })),
  };
}

const emptyRetrieval = () => ({
  minSimilarity: MIN_SIMILARITY,
  relativeGap: RELATIVE_GAP,
  candidates: [],
});

// Short questions that name a Constitution section ("What does section 26 say?",
// "Yintoni isiqendu 26 ...") are answered with the official text. No model call is needed.
function detectSectionRequest(q) {
  if (q.length > 90) return null;
  const xh = q.match(/\b(?:icandelo|isiqendu|isiqendwana)\s+(\d{1,2})\b/i);
  const en = q.match(/\bsection\s+(\d{1,2})\b/i);
  const m = xh || en;
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 7 || n > 39) return null;
  return { section: n, language: xh ? 'xh' : 'en' };
}

function toCitations(sources) {
  return sources.map((s, i) => ({
    number: i + 1,
    document_title: s.document_title,
    chunk_index: s.metadata?.chunk_index,
    reference: s.metadata?.reference,
    source: s.metadata?.source,
    similarity: s.similarity ?? null,
    content: s.content,
  }));
}

// A response with passages but no model-written answer
function sourcesOnly(res, { q, sources, retrieval, reason, messageKey }) {
  const lang = sources[0]?.language_code === 'xh' ? 'xh' : 'en';
  return res.json({
    question: q,
    refused: false,
    mode: 'sources_only',
    reason,
    answer: message(lang, messageKey),
    citations: toCitations(sources),
    retrieval,
    disclaimer: DISCLAIMER,
  });
}

/**
 * POST /api/ask
 * Body: { "question": "My landlord changed the locks, what can I do?", "matchCount": 5 }
 * Returns a cited answer, the matching passages when no answer can be written, or a refusal.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { question, matchCount = 5 } = body;

    if (typeof question !== 'string' || question.trim() === '') {
      return res.status(400).json({ error: 'Question parameter is required.' });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return res
        .status(400)
        .json({ error: 'Question must be ' + MAX_QUESTION_LENGTH + ' characters or fewer.' });
    }

    if (await rejectIfLimited(req, res, LIMITS.ask)) return;

    const q = question.trim();
    const count = Math.min(Math.max(Number(matchCount) || 5, 1), 8);
    console.log('Received question: "' + q + '"');

    // Step 1: "section N" questions get the official text, with no model call
    const lookup = detectSectionRequest(q);
    if (lookup) {
      const chunks = await getSectionChunks(lookup.section, lookup.language);
      if (chunks.length > 0) {
        return sourcesOnly(res, {
          q,
          sources: chunks,
          retrieval: emptyRetrieval(),
          reason: 'section_lookup',
          messageKey: 'official',
        });
      }
    }

    // Step 2: retrieval
    const { kept: sources, candidates } = await retrieve(q, count);
    const retrieval = retrievalSummary(candidates, sources);

    const refuse = (reason, answer) =>
      res.json({
        question: q,
        refused: true,
        reason,
        answer,
        citations: [],
        retrieval,
        disclaimer: DISCLAIMER,
      });

    // Refusal 1: nothing relevant retrieved. No model call.
    if (sources.length === 0) {
      return refuse(
        'no_relevant_sources',
        'I could not find anything about that in the guides I have, so I cannot answer it.'
      );
    }

    // Step 3: check the daily model-call budget before spending any quota
    const slot = await reserveGeneration(req);
    if (!slot.allowed) {
      console.log('Generation skipped: ' + slot.reason);
      return sourcesOnly(res, {
        q,
        sources,
        retrieval,
        reason: slot.reason,
        messageKey: 'unavailable',
      });
    }

    // Step 4: the model
    console.log(
      'Generating answer from ' + sources.length + ' source(s), models: ' + GEN_MODELS.join(' -> ')
    );

    let generated;
    try {
      generated = await generateAnswer(q, sources);
    } catch (err) {
      console.error('Ask Error (all models failed):', String(err.message).slice(0, 300));
      return sourcesOnly(res, {
        q,
        sources,
        retrieval,
        reason: 'generation_failed',
        messageKey: 'unavailable',
      });
    }
    const raw = generated.text;
    console.log('Answered by ' + generated.model);

    // Refusal 2: the model says the sources do not answer the question
    if (raw.includes('NOT_ENOUGH_INFORMATION')) {
      return refuse(
        'model_declined',
        'The guides I have do not contain enough information to answer that question.'
      );
    }

    // Refusal 3: an answer with no valid citation cannot be verified
    const cited = [
      ...new Set([...raw.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
    ].filter((n) => n >= 1 && n <= sources.length);

    if (cited.length === 0) {
      return refuse(
        'uncited_answer',
        'I could not produce an answer that is backed by my sources, so I am not giving one.'
      );
    }

    return res.json({
      question: q,
      refused: false,
      answer: raw,
      citations: cited
        .sort((a, b) => a - b)
        .map((n) => {
          const s = sources[n - 1];
          return {
            number: n,
            document_title: s.document_title,
            chunk_index: s.metadata?.chunk_index,
            reference: s.metadata?.reference,
            source: s.metadata?.source,
            similarity: s.similarity,
            content: s.content,
          };
        }),
      retrieval,
      model: generated.model,
      disclaimer: DISCLAIMER,
    });
  } catch (err) {
    if (err instanceof SearchError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Ask Error:', err);
    return res
      .status(502)
      .json({ error: 'The answer service is unavailable right now. Please try again.' });
  }
}