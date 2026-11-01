const MAX_BODY = 1024;
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function respond(status, data) {
  return Response.json(data, { status, headers });
}

export function createStatusHandler(status) {
  return () => respond(200, status());
}

export function createEnabledHandler(status, setEnabled) {
  return async (request) => {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return respond(415, { error: 'Expected JSON' });
    const contentLength = request.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY) return respond(413, { error: 'Request body too large' });
    if (!request.body) return respond(400, { error: 'Expected JSON body' });
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) return respond(413, { error: 'Request body too large' });
        chunks.push(value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof body.enabled !== 'boolean') return respond(400, { error: 'Expected enabled boolean' });
      if (!setEnabled(body.enabled)) return respond(503, status());
      return respond(200, status());
    } catch {
      return respond(400, { error: 'Invalid JSON' });
    } finally {
      reader.releaseLock();
    }
  };
}
