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

function classStyleMap(sourceHtml = '') {
  const styles = new Map();
  for (const match of sourceHtml.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
    styles.set(match[1], match[2]);
  }
  return styles;
}

function cleanHref(rawHref = '') {
  try {
    const url = new URL(rawHref, 'https://docs.google.com');
    if (url.hostname === 'www.google.com' && url.pathname === '/url' && url.searchParams.get('q')) {
      return url.searchParams.get('q');
    }
  } catch { /* Keep a non-standard but usable URL unchanged. */ }
  return rawHref;
}

function cleanInnerHtml(html = '', styles = new Map()) {
  const fragment = cheerio.load(`<div id="content-root">${html}</div>`);
  const root = fragment('#content-root');

  root.find('*').toArray().reverse().forEach(el => {
    const node = fragment(el);
    const tag = el.tagName.toLowerCase();
    const classStyles = (node.attr('class') || '')
      .split(/\s+/)
      .map(name => styles.get(name) || '')
      .join(';');
    const style = `${node.attr('style') || ''};${classStyles}`.toLowerCase();

    if (tag === 'a') {
      const href = cleanHref(node.attr('href') || '');
      const label = node.text().trim();
      if (!href || !label) node.replaceWith(node.contents());
      else node.replaceWith(`<a href="${escapeHtml(href)}">${node.html() || ''}</a>`);
      return;
    }

    if (tag === 'br') return;

    if (['strong', 'em', 'del', 'code'].includes(tag)) {
      node.replaceWith(`<${tag}>${node.html() || ''}</${tag}>`);
      return;
    }

    let inner = node.html() || '';
    const isBold = tag === 'b' || tag === 'strong' || /font-weight\s*:\s*(bold|[6-9]00|1000)/.test(style);
    const isItalic = tag === 'i' || tag === 'em' || /font-style\s*:\s*italic/.test(style);
    const isStrike = ['s', 'strike', 'del'].includes(tag) || /text-decoration[^;]*line-through/.test(style);
    const isCode = tag === 'code' || /font-family[^;]*(monospace|courier|consolas|menlo)/.test(style);

    if (isBold) inner = `<strong>${inner}</strong>`;
    if (isItalic) inner = `<em>${inner}</em>`;
    if (isStrike) inner = `<del>${inner}</del>`;
    if (isCode) inner = `<code>${inner}</code>`;
    node.replaceWith(inner);
  });

  return (root.html() || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function listItemLevel($, item, styles) {
  const node = $(item);
  const explicit = Number(node.attr('data-level') || node.attr('aria-level'));
  if (Number.isInteger(explicit) && explicit >= 0) return explicit;

  const classes = node.attr('class') || '';
  const levelClass = classes.match(/(?:li-(?:bullet|number)|level|indent)[_-](\d+)/i);
  if (levelClass) return Number(levelClass[1]);

  const classStyles = classes.split(/\s+/).map(name => styles.get(name) || '').join(';');
  const margin = `${node.attr('style') || ''};${classStyles}`.match(/margin-left\s*:\s*([\d.]+)(px|pt)?/i);
  if (!margin) return 0;
  const pixels = Number(margin[1]) * (margin[2]?.toLowerCase() === 'pt' ? 1.333 : 1);
  return Math.max(0, Math.round(pixels / 36));
}

function renderList($, list, styles) {
  const type = list.tagName.toLowerCase() === 'ol' ? 'ol' : 'ul';
  const items = $(list).children('li').toArray();
  const entries = items.map(item => ({ item, level: listItemLevel($, item, styles), children: [] }));
  const roots = [];
  const stack = [];

  entries.forEach(entry => {
    while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(entry);
    else roots.push(entry);
    stack.push(entry);
  });

  const renderEntries = (entriesToRender, listType) => `<${listType}>\n${entriesToRender.map(entry => {
    const item = entry.item;
    const $item = $(item);
    const semanticNested = $item.children('ul,ol').toArray().map(child => renderList($, child, styles)).join('');
    const inferredNested = entry.children.length ? renderEntries(entry.children, 'ul') : '';
    const clone = $item.clone();
    clone.children('ul,ol').remove();
    const checkbox = clone.find('input[type="checkbox"]').first();
    const marker = checkbox.length ? (checkbox.is('[checked]') ? '☑ ' : '☐ ') : '';
    clone.find('input[type="checkbox"]').remove();
    return `  <li>${marker}${cleanInnerHtml(clone.html() || '', styles)}${semanticNested}${inferredNested}</li>`;
  }).join('\n')}\n</${listType}>`;

  return renderEntries(roots, type);
}

function renderTable($, table, styles) {
  const rows = $(table).find('tr').toArray();
  if (!rows.length) return '';
  const renderRow = (row, cellTag) => `<tr>${$(row).children('th,td').toArray()
    .map(cell => `<${cellTag}>${cleanInnerHtml($(cell).html() || '', styles)}</${cellTag}>`).join('')}</tr>`;
  const header = renderRow(rows[0], 'th');
  const body = rows.slice(1).map(row => renderRow(row, 'td')).join('\n');
  return `<table>\n<thead>${header}</thead>\n<tbody>${body}</tbody>\n</table>`;
}

function renderBlockquote($, quote, styles) {
  const paragraphs = $(quote).children('p').toArray();
  if (!paragraphs.length) return `<blockquote>${cleanInnerHtml($(quote).html() || '', styles)}</blockquote>`;
  return `<blockquote>\n${paragraphs.map(p => `  <p>${cleanInnerHtml($(p).html() || '', styles)}</p>`).join('\n')}\n</blockquote>`;
}

function buildContentHtml($, elements, styles) {
  return elements.map(el => {
    const tag = el.tagName.toLowerCase();
    const inner = cleanInnerHtml($(el).html() || '', styles);
    const plain = text($(el).text());

    if (tag === 'ul' || tag === 'ol') return renderList($, el, styles);
    if (tag === 'table') return renderTable($, el, styles);
    if (tag === 'blockquote') return renderBlockquote($, el, styles);
    if (tag === 'pre') return `<pre><code>${escapeHtml($(el).text())}</code></pre>`;
    if (tag === 'hr') return '<hr>';
    if (/^h[1-6]$/.test(tag)) return `<${tag}>${inner}</${tag}>`;
    if (tag === 'li') return `<ul>\n  <li>${inner}</li>\n</ul>`;
    if (
      /^20\d{2}\s/.test(plain) ||
      /^(Test-Drive|Exterior|Interior|Performance|Safety|Technology|Colors|Dimensions|Features|FAQ)/i.test(plain) ||
      (plain.length <= 80 && !/[.!?]$/.test(plain) && /^[A-Z]/.test(plain) && plain.split(' ').length <= 10)
    ) return `<h2>${inner}</h2>`;
    return plain ? `<p>${inner}</p>` : '';
  }).filter(Boolean).join('\n');
}

function collectContentBlocks($) {
  const blocks = 'p,h1,h2,h3,h4,h5,h6,ul,ol,li,table,blockquote,pre,hr';
  return $('body').find(blocks).filter((_, el) => !$(el).parents(blocks).length).toArray();
}

const FIELD_LABEL_PATTERN =
  /^(keywords|tags|category|author|alt text|featured image alt text|meta title|meta description|page slug|image shortcode|cta buttons|buttons)\s*(\([^)]*\))?\s*:/i;

function isMetadataElement($, el) {
  return FIELD_LABEL_PATTERN.test(text($(el).text()));
}

function insertButtonsAfterFirstParagraph(content = '', buttons = '') {
  if (!buttons) return content;
  const cta = normalizeButtonsHtml(buttons);

  const firstParagraphEnd = content.indexOf('</p>');
  if (firstParagraphEnd === -1) return `${cta}\n\n${content}`.trim();

  return (
    content.slice(0, firstParagraphEnd + 4) +
    `\n\n${cta}\n\n` +
    content.slice(firstParagraphEnd + 4)
  ).trim();
}

function normalizeButtonsHtml(buttons = '') {
  const fragment = cheerio.load(`<div id="cta-root">${buttons}</div>`);
  const root = fragment('#cta-root');
  const groups = root.find('div').filter((_, el) => fragment(el).find('a.button, a.primary-button').length > 1);
  groups.each((_, group) => {
    const node = fragment(group);
    const style = node.attr('style') || '';
    if (!/\bgap\s*:/i.test(style)) {
      node.attr('style', `${style.replace(/;?\s*$/, ';')}display:flex;justify-content:center;gap:12px;flex-wrap:wrap;`);
    }
  });
  return (root.html() || '').trim();
}

function parseDealerTemplate(sourceHtml) {
  const $ = cheerio.load(sourceHtml);
  const styles = classStyleMap($('style').text());
  $('script,style,meta,link').remove();

  const allElements = collectContentBlocks($);

  const lines = allElements
    .map(el => text($(el).text()))
    .filter(Boolean);

  const slug      = readLabel(lines, 'Page Slug').replace(/^\/+|\/+$/g, '');
  const metaTitle = readLabel(lines, 'Meta Title');
  const metaDesc  = readLabel(lines, 'Meta Description');
  const keyword   = readLabel(lines, 'Keywords');
  const tags      = readLabel(lines, 'Tags');
  const category  = readLabel(lines, 'Category');
  const author    = readLabel(lines, 'Author');
  const altText   = readLabel(lines, 'Alt Text') || readLabel(lines, 'Featured Image Alt Text');
  const shortcode = readLabel(lines, 'Image Shortcode');
  const buttons   = readLabel(lines, 'Buttons') || readLabel(lines, 'CTA Buttons');

  // Metadata may appear before or after the article in a Google Doc.  Filter it
  // out by its label rather than assuming the remaining elements are all body copy.
  const articleElements = allElements.filter(el => {
    const tag = el.tagName.toLowerCase();
    // Structural elements such as <hr> intentionally contain no text.
    return (text($(el).text()) || tag === 'hr') && !isMetadataElement($, el);
  });

  if (!articleElements.length) {
    return { title: 'Untitled post', slug, metaTitle, metaDescription: metaDesc,
             keyword, tags, category, author, altText, imageShortcode: shortcode,
             buttons, content: '' };
  }

  const title = text($(articleElements[0]).text()) || 'Untitled post';

  const bodyElements = articleElements.slice(1);
  const bodyHtml = buildContentHtml($, bodyElements, styles);

  return {
    title,
    slug,
    metaTitle,
    metaDescription: metaDesc,
    keyword,
    tags,
    category,
    author,
    altText,
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

    // The selected image shortcode starts the article HTML; the CTA follows the
    // introductory paragraph. SEO and taxonomy metadata stay outside the body.
    const content = [
      post.imageShortcode,
      insertButtonsAfterFirstParagraph(post.content, post.buttons)
    ].filter(Boolean).join('\n\n');

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
if (process.env.NODE_ENV !== 'test' && process.env.NETLIFY_FUNCTION !== 'true') {
  app.listen(PORT, () => console.log(`Publishing bridge running on port ${PORT}`));
}

export { googleExportUrl, insertButtonsAfterFirstParagraph, parseDealerTemplate, wpConfig };
