import {
  retrieve,
  generateAnswer,
  rejectIfLimited,
  LIMITS,
  SearchError,
  GEN_MODELS,
  MIN_SIMILARITY,
  RELATIVE_GAP,
  MAX_QUESTION_LENGTH,
  DISCLAIMER,
} from '../lib/rag.js';

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

/**
 * POST /api/ask
 * Body: { "question": "My landlord changed the locks, what can I do?", "matchCount": 5 }
 * Returns a cited answer, or a refusal when the sources do not support one.
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
        .json({ error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.` });
    }

    if (await rejectIfLimited(req, res, LIMITS.ask)) return;

    const q = question.trim();
    const count = Math.min(Math.max(Number(matchCount) || 5, 1), 8);
    console.log(`Received question: "${q}"`);

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

    // Refusal 1: nothing relevant retrieved. Gemini is not called.
    if (sources.length === 0) {
      return refuse(
        'no_relevant_sources',
        'I could not find anything about that in the guides I have, so I cannot answer it.'
      );
    }

    console.log(
      `Generating answer from ${sources.length} source(s), models: ${GEN_MODELS.join(' -> ')}`
    );

    let generated;
    try {
      generated = await generateAnswer(q, sources);
    } catch (err) {
      console.error('Ask Error (all models failed):', String(err.message).slice(0, 300));
      return res.status(503).json({
        error: 'The answer service is busy right now. Please try again in a moment.',
      });
    }
    const raw = generated.text;
    console.log(`Answered by ${generated.model}`);

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