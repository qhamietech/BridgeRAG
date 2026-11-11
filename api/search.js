import { retrieve, rejectIfLimited, LIMITS, SearchError, MIN_SIMILARITY, RELATIVE_GAP } from '../lib/rag.js';

/**
 * POST /api/search
 * Body: { "query": "constitutional rights", "matchCount": 5 }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { query, matchCount = 5 } = body;

    if (!query) {
      return res.status(400).json({ error: 'Query parameter is required.' });
    }

    if (await rejectIfLimited(req, res, LIMITS.search)) return;

    console.log(`Received search query: "${query}"`);

    const { kept } = await retrieve(query, matchCount);

    return res.json({
      query,
      minSimilarity: MIN_SIMILARITY,
      relativeGap: RELATIVE_GAP,
      resultsCount: kept.length,
      results: kept,
      message: kept.length === 0 ? 'No sufficiently relevant results found.' : undefined,
    });
  } catch (err) {
    if (err instanceof SearchError) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Server Error:', err);
    return res.status(500).json({ error: 'Internal server error during search.' });
  }
}