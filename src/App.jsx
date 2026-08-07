import { useMemo, useState } from 'react';
import {
  ArrowUpRight, Calendar, Check, CheckCircle2, ChevronDown, CircleAlert, Copy,
  Clock3, ExternalLink, FileText, Globe2, Image, LayoutDashboard, Link2,
  MoreHorizontal, PanelRight, Plus, Search, Send, Settings2, Sparkles,
  Tag, WandSparkles, X
} from 'lucide-react';

const initialPosts = [
  { title: 'A practical guide to product-led growth', status: 'Draft', date: 'Today, 10:24 AM', score: 84 },
  { title: 'How to measure your content ROI', status: 'Scheduled', date: 'Aug 08, 9:00 AM', score: 92 },
  { title: 'The complete B2B SEO checklist', status: 'Published', date: 'Aug 03, 2:15 PM', score: 96 },
];

function scoreChecks(post) {
  const plain = post.content.replace(/<[^>]*>/g, ' ');
  const words = plain.trim().split(/\s+/).filter(Boolean);
  const headings = (post.content.match(/<h2/gi) || []).length;
  const links = (post.content.match(/<a /gi) || []).length;
  return [
    { label: 'Meta title length', detail: `${post.metaTitle.length}/60 characters`, state: post.metaTitle.length >= 30 && post.metaTitle.length <= 60 ? 'pass' : 'warning' },
    { label: 'Meta description', detail: `${post.metaDescription.length}/160 characters`, state: post.metaDescription.length >= 120 && post.metaDescription.length <= 160 ? 'pass' : 'warning' },
    { label: 'Heading structure', detail: `1 H1 · ${headings} H2 headings`, state: headings >= 2 ? 'pass' : 'warning' },
    { label: 'Keyword coverage', detail: post.keyword ? `"${post.keyword}" included` : 'Add a target keyword', state: post.keyword && plain.toLowerCase().includes(post.keyword.toLowerCase()) ? 'pass' : 'warning' },
    { label: 'Readability', detail: `${words.length} words · easy to scan`, state: words.length >= 250 ? 'pass' : 'warning' },
    { label: 'Image alt text', detail: post.altText ? 'Featured image described' : 'Missing alt text', state: post.altText ? 'pass' : 'error' },
    { label: 'Internal links', detail: links ? `${links} links detected` : 'Add 2–3 contextual links', state: links >= 2 ? 'pass' : 'warning' },
    { label: 'Publishing details', detail: post.category && post.author ? 'Author and category assigned' : 'Complete author and category', state: post.category && post.author ? 'pass' : 'error' },
  ];
}

function normalizeButtonsHtml(buttons = '') {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = buttons;
  const group = [...wrapper.querySelectorAll('div')].find(node => node.querySelectorAll('a.button, a.primary-button').length > 1);
  if (group && !/\bgap\s*:/i.test(group.style.cssText)) {
    group.style.cssText += ';display:flex;justify-content:center;gap:12px;flex-wrap:wrap;';
  }
  return wrapper.innerHTML.trim();
}

function buildArticleHtml(content = '', buttons = '', imageShortcode = '') {
  const cta = normalizeButtonsHtml(buttons);
  let article = content;

  if (cta) {
    const firstParagraphEnd = article.indexOf('</p>');
    article = firstParagraphEnd === -1
      ? `${cta}\n\n${article}`.trim()
      : (article.slice(0, firstParagraphEnd + 4) + `\n\n${cta}\n\n` + article.slice(firstParagraphEnd + 4)).trim();
  }

  return [imageShortcode, article].filter(Boolean).join('\n\n');
}

function App() {
  const [active, setActive] = useState('Editor');
  const [posts, setPosts] = useState(initialPosts);
  const [toast, setToast] = useState('');
  const [preview, setPreview] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [post, setPost] = useState({
    title: '', slug: '', metaTitle: '', metaDescription: '',
    category: '', tags: '', author: '', altText: '', keyword: '', imageShortcode: '', content: '',
    publishDate: '2026-08-06T09:00', status: 'Draft'
  });
  const checks = useMemo(() => scoreChecks(post), [post]);
  const passCount = checks.filter(c => c.state === 'pass').length;
  const blockers = checks.filter(c => c.state === 'error').length;
  const score = Math.round((passCount / checks.length) * 100);
  // Article output starts with the selected image shortcode, then includes the
  // CTA below paragraph one. SEO and taxonomy values remain separate.
  const articleHtml = buildArticleHtml(post.content, post.buttons, post.imageShortcode);
  const update = (key, value) => setPost(p => ({ ...p, [key]: value }));
  const notify = (text) => { setToast(text); setTimeout(() => setToast(''), 2800); };
  const copyValue = async (value, label) => { try { await navigator.clipboard.writeText(value); notify(`${label} copied.`); } catch { notify('Select and copy the text manually.'); } };
  const save = (status = 'Draft') => {
    const item = { title: post.title, status, date: status === 'Published' ? 'Just now' : 'Just saved', score };
    setPosts(list => [item, ...list.filter(p => p.title !== post.title)]);
    update('status', status);
    notify(status === 'Published' ? 'Post published to WordPress.' : 'Draft saved to your workspace.');
  };

  const importDoc = async () => {
    if (!importUrl.trim()) return notify('Paste a Google Docs link first.');
    setImporting(true);
    try {
      const response = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: importUrl }) });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch {
        throw new Error(`Import failed (HTTP ${response.status}): Netlify did not return a valid function response.`);
      }
      if (!response.ok) throw new Error(`Import failed (HTTP ${response.status}): ${data.error || 'No error details were returned.'}`);
      setPost(current => ({
        ...current,
        ...data,
        tags: data.tags || data.keyword || current.tags
      }));
      setImportOpen(false);
      notify('Google Doc imported — metadata and article body are ready.');
    } catch (error) { notify(error.message || 'Could not import this Google Doc.'); }
    finally { setImporting(false); }
  };

  const publishToWordPress = async (status = 'Draft') => {
    setPublishing(true);
    try {
      const response = await fetch('/api/wordpress/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...post, status })
      });

      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('Server returned an invalid response.'); }

      if (!response.ok) {
        throw new Error(data.error || 'WordPress draft failed');
      }

      console.log('WordPress Draft Created:', data);
      save('Draft');

      if (data.url) {
        window.open(data.url, '_blank', 'noopener,noreferrer');
      }

      notify(`WordPress draft created successfully. ID: ${data.id}`);

    } catch (error) {
      console.error(error);
      notify(error.message || 'Could not create WordPress draft.');
    } finally {
      setPublishing(false);
    }
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17}/></div><span>Cars Commerce</span></div>
      <div className="workspace"><span className="avatar">AC</span><span>Akshay</span><ChevronDown size={15}/></div>
      <nav>
        {[[LayoutDashboard,'Overview'],[FileText,'Posts'],[WandSparkles,'Editor'],[CheckCircle2,'QA Center'],[Image,'Media'],[Tag,'CTA Library']].map(([Icon,label]) => <button key={label} className={active === label ? 'nav active' : 'nav'} onClick={() => setActive(label)}><Icon size={18}/><span>{label}</span>{label === 'QA Center' && <b>2</b>}</button>)}
      </nav>
      <div className="sidebar-bottom"><button className="nav"><Settings2 size={18}/><span>Settings</span></button><div className="user"><span className="avatar photo">MC</span><span><strong>Maya Chen</strong><small>Editor</small></span><MoreHorizontal size={17}/></div></div>
    </aside>
    <main>
      <header className="topbar"><div className="crumb"><span>Posts</span><span>/</span><strong>{post.title}</strong></div><div className="top-actions">

        <button className="button ghost" onClick={() => setPreview(!preview)}>
          <ExternalLink size={16}/> {preview ? 'Back to edit' : 'Preview'}
        </button>

        <button className="button ghost" onClick={() => save()}>
          <Check size={16}/> Save draft
        </button>

        <button className="button primary" disabled={publishing} onClick={() => publishToWordPress('Draft')}>
          <Send size={16}/> {publishing ? 'Creating...' : 'Create WP Draft'}
        </button>

        <button className="button primary" onClick={() => setExportOpen(true)}>
          <Copy size={16}/> Copy-ready output
        </button>

      </div></header>
      {preview ? <Preview post={post} /> : <div className="workspace-grid">
        <section className="editor-pane">
          <div className="editor-heading"><div><p className="eyebrow">BLOG POST</p><h1>Compose & review</h1></div><button className="import-button" onClick={() => setImportOpen(true)}><Globe2 size={16}/> Import from Google Docs</button></div>
          <label className="field title-field"><span>Post title</span><input value={post.title} onChange={e => update('title', e.target.value)} /></label>
          <div className="editor-toolbar"><button><b>H1</b></button><button><b>B</b></button><button><i>I</i></button><button>↗</button><button>☷</button><span></span><button><Link2 size={16}/></button><button><Image size={16}/></button><button onClick={() => copyValue(articleHtml, 'Content HTML')} title="Copy article HTML with CTA after the first paragraph"><Copy size={15}/> HTML</button><button>•••</button></div>
          <div className="rich-editor" contentEditable suppressContentEditableWarning onInput={e => update('content', e.currentTarget.innerHTML)} dangerouslySetInnerHTML={{__html: post.content}} />
          <div className="editor-footer"><span><Clock3 size={15}/> Last saved just now</span><span>{post.content.replace(/<[^>]*>/g,' ').trim().split(/\s+/).filter(Boolean).length} words</span></div>
        </section>
        <aside className="details-pane">
          <div className="details-head"><h2>Publishing details</h2><button><PanelRight size={17}/></button></div>
          <Section title="SEO settings" icon={<Search size={16}/> } open><label className="field"><span>URL slug</span><div className="prefixed"><em>/blog/</em><input value={post.slug} onChange={e => update('slug', e.target.value)} /></div></label><label className="field"><span>Meta title <i>{post.metaTitle.length}/60</i></span><input value={post.metaTitle} onChange={e => update('metaTitle', e.target.value)} /></label><label className="field"><span>Meta description <i>{post.metaDescription.length}/160</i></span><textarea value={post.metaDescription} onChange={e => update('metaDescription', e.target.value)} /></label><label className="field"><span>Focus keyword</span><input value={post.keyword} onChange={e => update('keyword', e.target.value)} /></label></Section>
          <Section title="Taxonomy" icon={<Tag size={16}/> }><div className="two-fields"><label className="field"><span>Category</span><input value={post.category} onChange={e => update('category', e.target.value)} /></label><label className="field"><span>Author</span><input value={post.author} onChange={e => update('author', e.target.value)} /></label></div><label className="field"><span>Tags</span><input value={post.tags} onChange={e => update('tags', e.target.value)} /></label></Section>
          <Section title="Featured image" icon={<Image size={16}/> }><div className="featured"><div className="featured-art"><span>✦</span></div><div><strong>content-strategy.jpg</strong><small>1600 × 900 px</small><button>Replace image</button></div></div><label className="field"><span>Image shortcode</span><textarea value={post.imageShortcode} onChange={e => update('imageShortcode', e.target.value)} placeholder="Paste the selected image shortcode" /></label><label className="field"><span>Alt text</span><input value={post.altText} onChange={e => update('altText', e.target.value)} /></label></Section>
          <Section title="Draft settings" icon={<Calendar size={16}/> }><label className="field"><span>Target publish date</span><input type="datetime-local" value={post.publishDate} onChange={e => update('publishDate', e.target.value)} /></label><p className="section-note">WordPress upload will be added after the copy-and-review workflow is approved.</p></Section>
        </aside>
      </div>}
    </main>
    <aside className="qa-panel import-panel"><div className="qa-header"><div><p className="eyebrow">GOOGLE DOC IMPORT</p><h2>Imported fields</h2></div><button><MoreHorizontal size={19}/></button></div><p className="import-help">Review the imported information, then copy each item directly into WordPress.</p><div className="import-fields">{[['Post title', post.title], ['Meta title', post.metaTitle], ['Meta description', post.metaDescription], ['Page slug', post.slug ? `/${post.slug}/` : ''], ['Keywords', post.keyword], ['Category', post.category], ['Tags', post.tags], ['Author', post.author], ['Alt text', post.altText], ['Image shortcode', post.imageShortcode], ['CTA buttons', post.buttons]].map(([label, value]) => <div className="import-field" key={label}><div><strong>{label}</strong><button onClick={() => copyValue(value, label)} disabled={!value}><Copy size={13}/> Copy</button></div><p>{value || 'Not included in this document'}</p></div>)}</div><div className="import-html"><div><strong>Blog content HTML</strong><button onClick={() => copyValue(articleHtml, 'Blog content HTML')} disabled={!articleHtml}><Copy size={13}/>HTML</button></div><p>Article headings, paragraphs, lists, and the CTA after the first paragraph. Metadata is excluded.</p></div></aside>
    {importOpen && <div className="modal-wrap"><div className="modal"><button className="modal-close" onClick={() => setImportOpen(false)}><X size={18}/></button><div className="modal-icon"><Globe2 size={22}/></div><h2>Import from Google Docs</h2><p>Paste a shared Google Docs link. Your Keywords, Meta Title, Meta Description, Slug, image shortcode, buttons, and article body are mapped automatically.</p><input value={importUrl} onChange={e => setImportUrl(e.target.value)} placeholder="https://docs.google.com/document/d/..." autoFocus/><button className="button primary full" disabled={importing} onClick={importDoc}>{importing ? 'Importing…' : 'Import document'}</button><small>The document must be shared as "Anyone with the link".</small></div></div>}
    {exportOpen && <div className="modal-wrap"><div className="export-modal"><button className="modal-close" onClick={() => setExportOpen(false)}><X size={18}/></button><div className="modal-icon"><CheckCircle2 size={22}/></div><p className="eyebrow">READY FOR WORDPRESS</p><h2>Copy your prepared content</h2><p>Google Docs styling has been removed. Copy each clean field into its matching WordPress area.</p><div className="copy-grid">{[['Post title',post.title],['Meta title',post.metaTitle],['Meta description',post.metaDescription],['URL slug',`/${post.slug}/`],['Keywords',post.keyword],['Category',post.category],['Tags',post.tags],['Author',post.author],['Alt text',post.altText],['CTA buttons',post.buttons]].map(([label,value]) => <div className="copy-card" key={label}><div><span>{label}</span><button onClick={() => copyValue(value, label)}><Copy size={13}/> Copy</button></div><code>{value || 'Not provided'}</code></div>)}</div><div className="html-card"><div><span>Clean HTML article</span><button onClick={() => copyValue(articleHtml, 'Clean HTML')}><Copy size={13}/> </button></div><textarea readOnly value={articleHtml}/></div></div></div>}
    {toast && <div className="toast"><CheckCircle2 size={17}/>{toast}</div>}
  </div>;
}

function Section({ title, icon, children, open = true }) { const [isOpen, setOpen] = useState(open); return <section className="detail-section"><button className="section-title" onClick={() => setOpen(!isOpen)}>{icon}<strong>{title}</strong><ChevronDown className={isOpen ? '' : 'rotate'} size={16}/></button>{isOpen && <div className="section-body">{children}</div>}</section>; }
function Preview({ post }) { return <div className="preview"><div className="preview-top"><span>Previewing as it will appear on your site</span><button className="button ghost">Desktop <ChevronDown size={15}/></button></div><article><div className="preview-tag">{post.category || 'Uncategorized'}</div><h1>{post.title}</h1><p className="preview-dek">{post.metaDescription}</p><div className="preview-by"><span className="avatar photo">MC</span> By {post.author || 'Unassigned'} <span>•</span> Aug 6, 2026 <span>•</span> 6 min read</div><div className="hero-art">✦</div><div className="article-content" dangerouslySetInnerHTML={{__html: post.content.replace(/<h1[^>]*>.*?<\/h1>/,'')}} /></article></div> }

export default App;
