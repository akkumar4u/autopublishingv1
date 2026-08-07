let publishingModule;

async function publishing() {
  // Reuse the import/parser implementation without starting the Express server.
  process.env.NETLIFY_FUNCTION = 'true';
  publishingModule ??= import('../../server.js');
  return publishingModule;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' }
});

export default async request => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { url = '' } = await request.json();
    const { googleExportUrl, parseDealerTemplate } = await publishing();
    const response = await fetch(googleExportUrl(url));
    if (!response.ok) throw new Error('Cannot read Google Doc');
    return json(parseDealerTemplate(await response.text()));
  } catch (error) {
    console.error('Import error:', error.message);
    return json({ error: error.message || 'Could not import Google Doc' }, 400);
  }
};

export const config = { path: '/api/import' };
