/**
 * The two hub calls every page makes. Both send the session cookie and turn a
 * non-2xx into a throw, so callers only handle one failure shape.
 */

async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 401) {
    // The session cookie expired: reload into the login box rather than let every caller's
    // .catch() toast a "hub replied 401". The reload is already underway, so the promise it
    // returns never needs to settle.
    window.location.reload();
    return new Promise<Response>(() => {});
  }
  if (!response.ok) {
    // A JSON body's `error` (e.g. a 409's refusal reason) reads better than the bare status; fall
    // back to it when the body isn't JSON or carries no `error` field.
    const text = await response.text().catch(() => '');
    let message = `hub replied ${response.status}`;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        message = (body as { error: string }).error;
      }
    } catch {
      // not JSON — keep the status message
    }
    throw new Error(message);
  }
  return response;
}

export async function getJson<T>(url: string): Promise<T> {
  return (await request(url)).json() as Promise<T>;
}

/** POST with an optional JSON body; 204s and empty bodies come back as `null`. */
export async function sendJson<T>(url: string, body?: unknown, method = 'POST'): Promise<T | null> {
  const response = await request(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return text ? (JSON.parse(text) as T) : null;
}
