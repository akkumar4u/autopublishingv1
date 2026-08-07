let publishingModule;

async function publishing() {
  // Reuse the WordPress draft implementation without starting the Express server.
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
    const post = await request.json();
    const { insertButtonsAfterFirstParagraph, wpConfig } = await publishing();
    const config = wpConfig();
    const content = [
      post.imageShortcode,
      insertButtonsAfterFirstParagraph(post.content, post.buttons)
    ].filter(Boolean).join('\n\n');

    const response = await fetch(`${config.url}/posts/new`, {
      method: 'POST',
      headers: {
        Authorization: config.auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: post.title, content, status: 'draft' })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || result.message || 'WordPress rejected draft');

    return json({ success: true, id: result.ID, title: result.title, url: result.URL });
  } catch (error) {
    console.error('WordPress error:', error.message);
    return json({ error: error.message || 'Could not create WordPress draft' }, 400);
  }
};

export const config = { path: '/api/wordpress/draft' };
