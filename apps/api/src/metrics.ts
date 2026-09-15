import { createServer } from 'node:http';
import { Operations, prometheus } from '../../../packages/database/src/operations.js';
export function metricsServer(operations: Operations) {
 return createServer(async (request, response) => {
  response.setHeader('cache-control','no-store');
  if (request.method !== 'GET' || request.url !== '/metrics') { response.writeHead(404); response.end(); return; }
  try { const body = prometheus(await operations.snapshot()); response.writeHead(200, {'content-type':'text/plain; version=0.0.4; charset=utf-8'}); response.end(body); }
  catch { response.writeHead(503, {'content-type':'text/plain'}); response.end('Metrics unavailable\n'); }
 });
}
