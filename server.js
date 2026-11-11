import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { assertConfig } from './lib/rag.js';
import searchHandler from './api/search.js';
import askHandler from './api/ask.js';

try {
  assertConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

app.post('/api/search', searchHandler);
app.post('/api/ask', askHandler);

app.listen(PORT, () => {
  console.log(`BridgeRAG Search API live on http://localhost:${PORT}`);
});