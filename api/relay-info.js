// api/relay-info.js - Instancias Invidious usadas por el servidor y el cliente.
// El cliente las consulta al arrancar para resolver el audio directo (arranque rápido).
import { relayInstances } from './_relay.js';

export default function handler(req, res) {
  const body = JSON.stringify({ instances: relayInstances() });

  if (res && res.setHeader) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end(body);
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
