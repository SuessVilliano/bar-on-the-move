// Serverless proxy for GoHighLevel contact creation (Vercel Node function).
//
// SECURITY: the GHL Private Integration Token must never be in the browser.
// It is read here from the server-side env var GHL_TOKEN (Vercel project settings).
// The browser only sends form fields; source, base tags and locationId are fixed
// server-side so the public endpoint can't be used to write arbitrary CRM data.
//
//   GET  /api/ghl-contact -> { ok, configured }   (no GHL call)
//   POST /api/ghl-contact  { form: 'booking'|'staff'|'vendor', firstName, lastName,
//                            email, phone, eventType?, eventDate?, guests?, location?,
//                            addons?, notes? } -> { ok, id }

const GHL_BASE = 'https://services.leadconnectorhq.com';
const DEFAULT_LOCATION_ID = 'mmG9y85amdlwRHmSZOMJ'; // identifier, not a secret

const FORMS = {
  booking: { source: 'Bar on the Move Website', tags: ['website-booking'] },
  staff: { source: 'Bar on the Move — Staff Application', tags: ['staff-applicant', 'website-application'] },
  vendor: { source: 'Bar on the Move — Vendor Partner Application', tags: ['vendor-partner', 'license-holder', 'website-application'] },
};

function str(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function slug(v) {
  return str(v, 60).toLowerCase().replace(/[\s/]+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40);
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return null; }
  }
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

module.exports = async (req, res) => {
  const token = process.env.GHL_TOKEN || '';
  const locationId = process.env.GHL_LOCATION_ID || DEFAULT_LOCATION_ID;

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, configured: Boolean(token) });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!token) {
    return res.status(503).json({ ok: false, error: 'GHL is not configured on the server' });
  }

  const body = await readJson(req);
  if (!body) return res.status(400).json({ ok: false, error: 'Invalid JSON' });

  const form = FORMS[body.form];
  if (!form) return res.status(400).json({ ok: false, error: 'Unknown form' });

  const email = str(body.email, 254);
  const phone = str(body.phone, 40);
  if (!email && !phone) return res.status(400).json({ ok: false, error: 'Email or phone is required' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }

  const payload = {
    locationId,
    firstName: str(body.firstName, 100),
    lastName: str(body.lastName, 100),
    email: email || undefined,
    phone: phone || undefined,
    source: form.source,
    tags: [...form.tags],
  };

  if (body.form === 'booking') {
    const eventTag = slug(body.eventType);
    const guests = str(body.guests, 40);
    if (eventTag) payload.tags.push(eventTag);
    if (guests) payload.tags.push(`guests-${slug(guests)}`);
    payload.customField = [
      { key: 'event_type', field_value: str(body.eventType, 100) },
      { key: 'event_date', field_value: str(body.eventDate, 40) },
      { key: 'guest_count', field_value: guests },
      { key: 'event_location', field_value: str(body.location, 200) },
      { key: 'add_ons', field_value: str(body.addons, 500) },
      { key: 'event_notes', field_value: str(body.notes, 2000) },
    ];
  }

  try {
    const r = await fetch(`${GHL_BASE}/contacts/`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'CRM rejected the request' });
    }
    const id = (data.contact && data.contact.id) || data.id || null;
    return res.status(200).json({ ok: true, id });
  } catch (_) {
    return res.status(502).json({ ok: false, error: 'CRM unavailable' });
  }
};
