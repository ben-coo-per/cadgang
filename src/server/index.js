/**
 * cadgang server: REST API + WebSocket live updates + static web UI.
 *
 *   node src/server/index.js          # http://localhost:4477
 *   CADGANG_PORT=5000 npm start
 */

import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ModelDocument } from '../core/document.js';
import { apiRouter } from './api.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const PORT = parseInt(process.env.CADGANG_PORT || '4477', 10);
const DOC_PATH = process.env.CADGANG_DOC || path.join(ROOT, 'data', 'document.json');

const doc = new ModelDocument(DOC_PATH);
const app = express();
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/** JSON-stringify an object and send it to every open WebSocket client. */
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

app.use('/api', apiRouter(doc, ROOT, broadcast));
app.use(express.static(path.join(ROOT, 'web')));

doc.onChange(() => broadcast({ type: 'document_changed', revision: doc.revision }));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', revision: doc.revision }));
});

server.listen(PORT, () => {
  console.log(`cadgang server running at http://localhost:${PORT}`);
  console.log(`model document: ${DOC_PATH}`);
});
