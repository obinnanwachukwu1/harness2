const http = require('node:http');
const { readItems } = require('./store');

const port = Number(process.env.PORT || 3000);

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'node-service-starter',
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/items') {
    sendJson(res, 200, {
      items: readItems(),
    });
    return;
  }

  sendJson(res, 404, {
    error: 'Not found',
  });
});

if (require.main === module) {
  server.listen(port, () => {
    process.stdout.write(`service listening on http://localhost:${port}\n`);
  });
}

module.exports = {
  server,
};
