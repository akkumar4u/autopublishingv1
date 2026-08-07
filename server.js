import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import * as cheerio from 'cheerio';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(cors());
app.use(express.json({ limit: '3mb' }));

// Serve built frontend assets
app.use(express.static(path.join(__dirname, 'dist')));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const text = (value = '') =>
  value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

const escapeHtml = (value = '') =>
  value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));

const wpConfig = () => {
  const { WP_SITE, WP_ACCESS_TOKEN } = process.env;

  console.log("WP SITE:", WP_SITE);
  console.log("TOKEN LENGTH:", WP_ACCESS_TOKEN?.length);

  if (!WP_SITE || !WP_ACCESS_TOKEN) {
    throw new Error('Add WP_SITE and WP_ACCESS_TOKEN to .env');
  }

  return {
    url:
      'https://public-api.wordpress.com/rest/v1.1/sites/' +
      WP_SITE.replace('https://', ''),
    auth: `Bearer ${WP_ACCESS_TOKEN}`
  };
};

function googleExportUrl(url) {
  const match =
    url.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);

  if (!match) {
    throw new Error('Please enter a valid Google Docs link.');
  }

  return `https://docs.google.com/document/d/${match[1]}/export?format=html`;
}

function readLabel(lines, label) {
  const pattern = new RegExp(
    '^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\([^)]*\\))?\\s*:',
    'i'
  );

  const row = lines.find(line => pattern.test(line));
  if (!row) return '';

  const colonIdx = row.indexOf(':');
  return colonIdx >= 0 ? row.slice(colonIdx + 1).trim() : '';
}

function cleanInnerHtml(html = '') {
  let result = html
    .replace(/<span[^>]*font-weight\s*:\s*(bold|[6-9]00|1000)[^>]*>([\s\S]*?)<\/span>/gi, '<strong>$2</strong>')
    .replace(/<span[^>]*font-style\s*:\s*italic[^>]*>([\s\S]*?)<\/span>/gi, '<em>$1</em>')
    .replace(/<b([^>]*)>([\s\S]*?)<\/b>/gi, '<strong>$2</strong>')
    .replace(/<i([^>]*)>([\s\S]*?)<\/i>/gi, '<em>$2</em>')
    .replace(/<\/?p[^>]*>/gi, '')
    .replace(/<\/?span[^>]*>/gi, '')
    .replace(/<(strong|em)(\s[^>]*)?>/gi, '<$1>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  result = result.replace(
    /^<strong>([^:<>]+):\s*([^<]+)<\/strong>$/i,
    '<strong>$1:</strong> $2'
  );

  return result;
}

function buildContentHtml($, elements) {
  let html = '';
  let inList = false;

  elements.forEach(el => {
    const tag      = el.tagName.toLowerCase();
    const inner    = cleanInnerHtml($(el).html() || '');
    const plain    = text($(el).text());

    if (tag === 'li') {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `  <li>${inner}</li>\n`;
      return;
    }

    if (inList) { html += '</ul>\n'; inList = false; }

    if (tag === 'h1') {
      html += `<h1>${inner}</h1>\n`;
    } else if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
      html += `<h2>${inner}</h2>\n`;
    } else if (
      /^20\d{2}\s/.test(plain) ||
      /^(Test-Drive|Exterior|Interior|Performance|Safety|Technology|Colors|Dimensions|Features|FAQ)/i.test(plain) ||
      (plain.length <= 80 && !/[.!?]$/.test(plain) && /^[A-Z]/.test(plain) && plain.split(' ').length <= 10)
    ) {
      html += `<h2>${inner}</h2>\n`;
    } else if (plain) {
      html += `<p>${inner}</p>\n`;
    }
  });

  if (inList) html += '</ul>\n';
  return html;
}

const META_LABEL_PATTERN =
  /^(keywords|meta title|meta description|page slug|image shortcode|cta buttons|buttons)/i;

function parseDealerTemplate(sourceHtml) {
  const $ = cheerio.load(sourceHtml);
  $('script,style,meta,link').remove();

  const allElements = $('body').find('p,h1,h2,h3,h4,li').toArray();

  const lines = allElements
    .map(el => text($(el).text()))
    .filter(Boolean);

  const slug      = readLabel(lines, 'Page Slug').replace(/^\/+|\/+$/g, '');
  const metaTitle = readLabel(lines, 'Meta Title');
  const metaDesc  = readLabel(lines, 'Meta Description');
  const keyword   = readLabel(lines, 'Keywords');
  const shortcode = readLabel(lines, 'Image Shortcode');
  const buttons   = readLabel(lines, 'Buttons') || readLabel(lines, 'CTA Buttons');

  const metaValues = new Set(
    [slug, metaTitle, metaDesc, keyword, shortcode, buttons].filter(Boolean)
  );

  const contentStartIndex = allElements.findIndex(el => {
    const plain = text($(el).text());
    return plain && !META_LABEL_PATTERN.test(plain) && !metaValues.has(plain);
  });

  if (contentStartIndex < 0) {
    return { title: 'Untitled post', slug, metaTitle, metaDescription: metaDesc,
             keyword, imageShortcode: shortcode, buttons, content: '' };
  }

  const contentElements = allElements.slice(contentStartIndex);
  const title = text($(contentElements[0]).text()) || 'Untitled post';

  const bodyElements = contentElements.slice(1);
  const bodyHtml = buildContentHtml($, bodyElements);

  return {
    title,
    slug,
    metaTitle,
    metaDescription: metaDesc,
    keyword,
    imageShortcode:  shortcode,
    buttons,
    content: bodyHtml,
  };
}

// Import Google Doc
app.post('/api/import', async (req, res) => {
  try {
    const exportUrl = googleExportUrl(req.body.url || '');
    const response = await fetch(exportUrl);

    if (!response.ok)
      throw new Error('Cannot read Google Doc');

    const data = parseDealerTemplate(await response.text());
    res.json(data);

  } catch (error) {
    console.error('Import error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// Create WordPress Draft
app.post('/api/wordpress/draft', async (req, res) => {
  try {
    const config = wpConfig();
    const post = req.body;

    const content = [
      post.imageShortcode,
      post.content,
      post.buttons
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await fetch(
      `${config.url}/posts/new`,
      {
        method: 'POST',
        headers: {
          Authorization: config.auth,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          title: post.title,
          content: content,
          status: 'draft'
        })
      });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error ||
        result.message ||
        'WordPress rejected draft'
      );
    }

    res.json({
      success: true,
      id: result.ID,
      title: result.title,
      url: result.URL
    });

  } catch (error) {
    console.error('WordPress error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// SPA catch-all: serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`Publishing bridge running on port ${PORT}`));
