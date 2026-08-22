import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import defaultAvatarUrl from './assets/default-avatar.png';
import qrBgCollageUrl from './assets/qr-bg-collage.png';
import qrBgMinimalUrl from './assets/qr-bg-minimal.png';
import qrBgPunkUrl from './assets/qr-bg-punk.png';
import apiDocsMarkdown from '../ApiDocs.md?raw';
import { FaceTransfer } from './face-transfer';
import { BrowserUploadQueue, IndexedDbUploadPersistence, type ApiRequestOptions, type UploadTask } from './upload-client';
import { ExpiryDatePicker } from './expiry-date-picker';
import { mimeTypeForArchivePath, previewKind, type PreviewKind } from './preview-policy';
import { extractZipEntries, normalizeZipEntryName, selectZipHtmlEntry } from './zip-preview';
import { MAX_UPLOAD_SIZE } from './transfer-policy';
import { getInitialLanguage, I18nProvider, LanguageSwitcher, translate, useI18n } from './i18n';
import {
  ChevronDown,
  ChevronRight,
  Check,
  Bold,
  Code2,
  Clipboard,
  Download,
  FileUp,
  Heading2,
  Italic,
  KeyRound,
  Link as LinkIcon,
  Link2,
  List,
  ListFilter,
  LogOut,
  Menu,
  MoreVertical,
  Moon,
  Pencil,
  QrCode,
  RefreshCw,
  RotateCw,
  ScanLine,
  Share2,
  Search,
  Settings,
  Shield,
  Sun,
  Table2,
  TextCursorInput,
  Trash2,
  Upload,
  UserRound,
  Quote,
  X
} from 'lucide-react';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

type Role = 'admin' | 'user';
type User = { id?: string; uuid?: string; username: string; name?: string; role: Role; avatar_url?: string };
type Visibility = 'public' | 'internal' | 'private';
type Content = {
  id: string;
  owner_username: string;
  title: string;
  slug: string;
  type: 'text' | 'file' | 'mixed';
  format: 'plain' | 'markdown';
  text_content?: string;
  visibility: Visibility;
  status: 'active' | 'expired' | 'deleted' | 'processing';
  expire_at?: string | null;
  max_views: number;
  view_count: number;
  download_count: number;
  file_size: number;
  remark?: string;
  created_at: string;
  share_ticket?: string;
  attachments?: Attachment[];
};
type Attachment = { id: string; filename: string; content_type: string; size: number; media_ticket?: string; office_preview_allowed?: boolean };
type Toast = { id: number; text: string; kind?: 'ok' | 'error' };
type UploadProgress = { visible: boolean; stage: string; fileName: string; remaining: number; progress: number; speed?: number; eta?: number; failed?: boolean };
type PreviewInfo = { id: string; filename: string; content_type: string; size: number; kind: PreviewKind; preview_url: string; download_url: string; office_embed_url?: string | null };
type ShareNote = {
  id: string;
  parent_id?: string | null;
  body: string;
  visibility: 'public' | 'private';
  mode: 'comment' | 'memo';
  ip_region?: string;
  created_at: string;
  updated_at: string;
  author: { username: string; name?: string; avatar_url?: string };
  replies?: ShareNote[];
};

const SSO_URL = 'https://accounts.aryuki.com';
const APP_ID = 'content-share';
const BASE_URL = 'https://content.aryuki.com';
const visibilityOptions: Visibility[] = ['public', 'internal', 'private'];

function token() {
  return localStorage.getItem('sso_token') || '';
}

function uploadQueueDatabaseName(username: string): string {
  return `content-share-upload-queue:${encodeURIComponent(username.trim().toLowerCase())}`;
}

function deleteUploadDatabase(name: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function shareHeaders(password: string, shareTicket = ''): HeadersInit | undefined {
  const headers = new Headers();
  if (password) headers.set('x-share-password', password);
  if (shareTicket) headers.set('x-share-ticket', shareTicket);
  return [...headers.keys()].length ? headers : undefined;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token()) headers.set('Authorization', `Bearer ${token()}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
  return data as T;
}

function uploadApi<T>({ method, path, body }: ApiRequestOptions): Promise<T> {
  return api<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function fmtBytes(n = 0) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fmtEta(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
  const language = getInitialLanguage();
  if (seconds < 60) return language === 'en-US' ? `${Math.ceil(seconds)} sec` : `${Math.ceil(seconds)} 秒`;
  return language === 'en-US' ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds / 60)} 分钟`;
}

function fmtDate(v?: string | null) {
  return v ? new Date(v).toLocaleString(getInitialLanguage() === 'en-US' ? 'en-US' : 'zh-CN') : translate(getInitialLanguage(), 'common.permanent');
}

function publicLink(slug: string) {
  return `${location.origin}/s/${slug}`;
}

function avatarSrc(url?: string | null) {
  const value = String(url || '').trim();
  if (!value) return defaultAvatarUrl;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (value.startsWith('/')) return `${SSO_URL}${value}`;
  return value;
}

function DownloadButton({ url, className = 'primary', children }: { url: string; className?: string; children: React.ReactNode }) {
  return <button type="button" className={className} onClick={() => location.assign(url)}>{children}</button>;
}

function authCenterProfile(user: User) {
  return `${SSO_URL}/${encodeURIComponent(user.uuid || user.id || user.username)}`;
}

function escapeHtml(input: string) {
  return input.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
}

function renderTextHtml(format: 'plain' | 'markdown', text = '') {
  return format === 'markdown'
    ? DOMPurify.sanitize(enhanceMarkdownTables(String(marked.parse(text || ''))), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['iframe', 'object', 'embed', 'form', 'style'],
        FORBID_ATTR: ['style']
      })
    : `<pre>${escapeHtml(text || '')}</pre>`;
}

function enhanceMarkdownTables(html: string) {
  if (typeof document === 'undefined') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  template.content.querySelectorAll('table').forEach((table) => {
    const replacement = document.createElement('div');
    replacement.className = 'md-table';
    table.querySelectorAll('tr').forEach((tr) => {
      const row = document.createElement('div');
      row.className = 'md-table-row';
      tr.querySelectorAll('th,td').forEach((cell) => {
        const next = document.createElement('div');
        next.className = `md-table-cell ${cell.tagName.toLowerCase() === 'th' ? 'md-table-head' : ''}`.trim();
        next.innerHTML = cell.innerHTML;
        row.appendChild(next);
      });
      replacement.appendChild(row);
    });
    table.replaceWith(replacement);
  });
  return template.innerHTML;
}

function TextPreviewBox({ html, rawText, className = '' }: { html: string; rawText: string; className?: string }) {
  const { t, language } = useI18n();
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLElement>(null);
  const copy = async () => {
    await navigator.clipboard.writeText(rawText || '');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const selectBody = () => {
    const node = bodyRef.current;
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };
  const handleSelectShortcut = (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectBody();
      }
  };
  return (
    <div className={`text-preview-box ${className}`} tabIndex={0} onKeyDown={handleSelectShortcut}>
      <button type="button" className={`soft preview-copy-btn ${copied ? 'copied' : ''}`} onClick={copy} aria-label={language === 'en-US' ? 'Copy full text' : '复制全文'} title={language === 'en-US' ? 'Copy full text' : '复制全文'}>
        {copied ? <Check size={16} /> : <Clipboard size={16} />}
        <span>{copied ? (language === 'en-US' ? 'Copied' : '已复制') : (language === 'en-US' ? 'Copy full text' : '复制全文')}</span>
      </button>
      <article ref={bodyRef} tabIndex={0} className="preview content-preview selectable-content" onKeyDown={handleSelectShortcut} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function login() {
  location.href = `${SSO_URL}/?client_id=${APP_ID}&redirect=${encodeURIComponent(`${location.origin}/sso-callback`)}`;
}

function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = (text: string, kind: Toast['kind'] = 'ok') => {
    const item = { id: Date.now() + Math.random(), text, kind };
    setToasts((items) => [...items, item]);
    window.setTimeout(() => setToasts((items) => items.filter((t) => t.id !== item.id)), 3600);
  };
  return { toasts, push };
}

function Toasts({ items }: { items: Toast[] }) {
  return <div className="toasts" aria-live="polite">{items.map((t) => <div className={`toast ${t.kind || 'ok'}`} key={t.id}>{t.text}</div>)}</div>;
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function VisibilitySegment({ value, onChange }: { value: Visibility; onChange: (v: Visibility) => void }) {
  const { t, language } = useI18n();
  const index = visibilityOptions.findIndex((item) => item === value);
  return (
    <div className="visibility-segment" role="radiogroup" aria-label={t('visibility.label')}>
      <i style={{ transform: `translateX(${Math.max(index, 0) * 100}%)` }} />
      {visibilityOptions.map((item) => (
        <button type="button" key={item} className={value === item ? 'on' : ''} onClick={() => onChange(item)}>
          {t(`visibility.${item}`)}
        </button>
      ))}
    </div>
  );
}

type FilterMenuItem = { key: string; label: string; options: Array<{ value: string; label: string }> };

function FilterMenu({ items, values, onChange, onClear }: { items: FilterMenuItem[]; values: Record<string, string>; onChange: (key: string, value: string) => void; onClear: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const activeCount = Object.values(values).filter(Boolean).length;
  return (
    <div className="filter-menu-wrap">
      <button type="button" className={`soft filter-toggle${activeCount ? ' active' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={t('filters.open')} title={t('filters.open')}>
        <ListFilter size={16} />
        {activeCount > 0 && <span className="filter-count">{activeCount}</span>}
      </button>
      {open && <>
        <button type="button" className="filter-menu-scrim" aria-label={t('filters.close')} onClick={() => setOpen(false)} />
        <div className="filter-menu" role="dialog" aria-label={t('filters.open')}>
          {items.map((item) => <div className="filter-menu-group" key={item.key}>
            <strong>{item.label}</strong>
            <div className="filter-menu-options">
              {item.options.map((option) => <button type="button" key={option.value} className={values[item.key] === option.value ? 'selected' : ''} onClick={() => onChange(item.key, option.value)}>{option.label}</button>)}
            </div>
          </div>)}
          <button type="button" className="soft filter-clear" onClick={onClear}><X size={14} /> {t('filters.clear')}</button>
        </div>
      </>}
    </div>
  );
}

function Sidebar({ page, setPage, user, open, setOpen, collapsed, setCollapsed }: { page: string; setPage: (v: string) => void; user: User; open: boolean; setOpen: (v: boolean) => void; collapsed: boolean; setCollapsed: (v: boolean) => void }) {
  const { t, language } = useI18n();
  const items = [
    ['text', t('nav.publishText'), TextCursorInput],
    ['file', t('nav.publishFile'), FileUp],
    ['face', t('nav.faceTransfer'), ScanLine],
    ['mine', t('nav.myContent'), Clipboard],
    ['keys', t('nav.apiKeys'), KeyRound],
    ['settings', t('nav.settings'), Settings]
  ] as const;
  return (
    <aside className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand">
      <div className="brand-lockup">
          <span className="brand-mark"><Share2 size={18} /></span>
          <span className="brand-name">ShareWorker<small>{t('nav.contentDesk')}</small></span>
        </div>
        <button className="icon sidebar-toggle" onClick={() => { if (open) { setOpen(false); return; } setCollapsed(!collapsed); }} aria-label={open ? t('nav.closeSidebar') : collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')} title={open ? t('nav.closeSidebar') : collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}><Menu size={18} /></button>
      </div>
      <nav>
        {items.map(([id, label, Icon]) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); setOpen(false); }} title={label}>
            <Icon size={18} /> <span>{label}</span>
          </button>
        ))}
        {user.role === 'admin' && (
          <button className={page === 'admin' ? 'active' : ''} onClick={() => { setPage('admin'); setOpen(false); }} title={t('nav.admin')}>
            <Shield size={18} /> <span>{t('nav.admin')}</span>
          </button>
        )}
      </nav>
      <div className="side-foot">{t('nav.sso')}</div>
    </aside>
  );
}

function Header({ title, onMenu, dark, setDark, user }: { title: string; onMenu: () => void; dark: boolean; setDark: (v: boolean) => void; user: User }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const logout = async () => {
    localStorage.removeItem('sso_token');
    await Promise.all([
      deleteUploadDatabase(uploadQueueDatabaseName(user.username)),
      deleteUploadDatabase('content-share-upload-queue')
    ]);
    location.href = `${SSO_URL}/logout?redirect=${encodeURIComponent(location.origin)}`;
  };
  return (
    <header className="topbar">
      <button className="icon mobile-only" onClick={onMenu} aria-label={t('nav.openSidebar')}><Menu /></button>
      <h1>{title}</h1>
      <div className="top-actions">
        <LanguageSwitcher />
        <button className="soft theme-toggle" onClick={() => setDark(!dark)}>{dark ? <Sun size={16} /> : <Moon size={16} />} {dark ? t('theme.light') : t('theme.dark')}</button>
        <div className="user-area">
          <span className="user-name">{user.name || user.username}</span>
          <button className="avatar-btn" onClick={() => setOpen(!open)} aria-label={t('user.openMenu')}>
            <img src={avatarSrc(user.avatar_url)} alt={`${user.username} 头像`} />
          </button>
          <button className="icon logout-icon" onClick={logout} aria-label={t('user.logout')} title={t('user.logout')}><LogOut size={18} /></button>
          {open && (
            <>
              <button type="button" className="user-menu-scrim" aria-label={t('user.closeMenu')} onClick={() => setOpen(false)} />
              <div className="user-menu">
                <div className="user-card">
                  <img src={avatarSrc(user.avatar_url)} alt={`${user.username} 头像`} />
                  <div>
                    <strong>{user.name || user.username}</strong>
                    <small>{user.username}</small>
                  </div>
                </div>
                <dl>
                  <div><dt>{t('user.identity')}</dt><dd>{user.role}</dd></div>
                  <div><dt>{t('user.uuid')}</dt><dd>{user.uuid || user.id || '-'}</dd></div>
                </dl>
                <a className="soft menu-link" href={authCenterProfile(user)} target="_blank" rel="noreferrer">{t('user.openProfile')}</a>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function MarkdownToolbar({ textareaRef, content, setContent }: { textareaRef: React.RefObject<HTMLTextAreaElement>; content: string; setContent: (v: string) => void }) {
  const { t, language } = useI18n();
  const apply = (before: string, after = '', placeholder = 'text') => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = `${content.slice(0, start)}${before}${selected}${after}${content.slice(end)}`;
    setContent(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };
  const insertLine = (value: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const next = `${content.slice(0, start)}${value}${content.slice(start)}`;
    setContent(next);
    requestAnimationFrame(() => el.focus());
  };
  return (
    <div className="markdown-toolbar" aria-label="Markdown toolbar">
      <button type="button" title="Bold" aria-label="Bold" onClick={() => apply('**', '**', language === 'en-US' ? 'bold text' : '加粗文字')}><Bold size={17} /></button>
      <button type="button" title="Italic" aria-label="Italic" onClick={() => apply('*', '*', language === 'en-US' ? 'italic text' : '斜体文字')}><Italic size={17} /></button>
      <button type="button" title="Heading 2" aria-label="Heading 2" onClick={() => insertLine(language === 'en-US' ? '\n## Heading\n' : '\n## 标题\n')}><Heading2 size={17} /></button>
      <button type="button" title="Link" aria-label="Link" onClick={() => apply('[', '](https://)', language === 'en-US' ? 'link text' : '链接文字')}><Link2 size={17} /></button>
      <button type="button" title="Inline code" aria-label="Inline code" onClick={() => apply('`', '`', 'code')}><Code2 size={17} /></button>
      <button type="button" title="Table" aria-label="Table" onClick={() => insertLine(language === 'en-US' ? '\n| Col A | Col B |\n| --- | --- |\n| Value | Value |\n' : '\n| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |\n')}><Table2 size={17} /></button>
      <button type="button" title="List" aria-label="List" onClick={() => insertLine(language === 'en-US' ? '\n- List item\n' : '\n- 列表项\n')}><List size={17} /></button>
      <button type="button" title="Quote" aria-label="Quote" onClick={() => insertLine(language === 'en-US' ? '\n> Quote\n' : '\n> 引用\n')}><Quote size={17} /></button>
    </div>
  );
}

function PublishText({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [format, setFormat] = useState<'markdown' | 'plain'>('plain');
  const [mobileTab, setMobileTab] = useState<'pure' | 'preview'>('pure');
  const [form, setForm] = useState({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public' as Visibility, expire_at: '', max_views: 0 });
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => renderTextHtml(format, form.content), [format, form.content]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ url: string }>('/api/contents/text', { method: 'POST', body: JSON.stringify({ ...form, format, expire_at: form.expire_at || null }) });
      toast(language === 'en-US' ? `Created: ${res.url}` : `已创建：${res.url}`);
      setForm({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public', expire_at: '', max_views: 0 });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="panel publish" onSubmit={submit}>
      <div className="panel-head publish-head">
        <div className="segmented">
          <button type="button" className={format === 'markdown' ? 'on' : ''} onClick={() => setFormat('markdown')}>{t('text.markdown')}</button>
          <button type="button" className={format === 'plain' ? 'on' : ''} onClick={() => setFormat('plain')}>{t('text.plain')}</button>
        </div>
        <button className="primary" disabled={busy || !form.content.trim()}><Upload size={16} /> {t('text.create')}</button>
      </div>
      {format === 'markdown' ? (
        <>
          <MarkdownToolbar textareaRef={textareaRef} content={form.content} setContent={(content) => setForm({ ...form, content })} />
          <div className="mobile-tabs pure-tabs">
            <button type="button" className={mobileTab === 'pure' ? 'on' : ''} onClick={() => setMobileTab('pure')}>{t('text.pure')}</button>
            <button type="button" className={mobileTab === 'preview' ? 'on' : ''} onClick={() => setMobileTab('preview')}>{t('text.preview')}</button>
          </div>
          <div className="editor-grid">
            <textarea ref={textareaRef} className={mobileTab === 'pure' ? '' : 'mobile-hide'} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={t('text.markdownPlaceholder')} />
            <TextPreviewBox className={mobileTab === 'preview' ? '' : 'mobile-hide'} html={preview} rawText={form.content} />
          </div>
        </>
      ) : (
        <textarea className="plain-editor" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={t('text.plainPlaceholder')} />
      )}
      <OptionsGrid form={form} setForm={setForm} />
    </form>
  );
}

function OptionsGrid({ form, setForm }: { form: any; setForm: (v: any) => void }) {
  const { t } = useI18n();
  return (
    <div className="options-grid">
      <Field label={t('text.title')}><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={t('text.optionalTitle')} /></Field>
      <Field label={t('text.slug')}><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder={t('text.randomSlug')} /></Field>
      <Field label={t('text.password')}><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder={t('text.optional')} /></Field>
      <ExpiryDatePicker className="expire-field" value={form.expire_at} onChange={(expire_at) => setForm({ ...form, expire_at })} />
      <Field label={t('text.maxViews')} className="max-views-field"><input type="number" min="0" value={form.max_views} onChange={(e) => setForm({ ...form, max_views: Number(e.target.value) })} /></Field>
      <Field label={t('visibility.label')} className="status-field"><VisibilitySegment value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} /></Field>
      <Field label={t('text.remark')} className="remark-field"><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder={t('text.optionalRemark')} /></Field>
    </div>
  );
}

function UploadFloating({ state, onClose }: { state: UploadProgress; onClose: () => void }) {
  const { t, language } = useI18n();
  if (!state.visible) return null;
  return (
    <div className="upload-float">
      <div className="panel-head">
        <h2>{t('upload.queue')}</h2>
        {(state.progress >= 100 || state.failed) && <button className="icon" onClick={onClose} aria-label={t('upload.closeStatus')}><X size={16} /></button>}
      </div>
      <strong title={state.fileName}>{state.fileName}</strong>
      <span>{state.stage} · {t('upload.remaining', { count: state.remaining })}</span>
      <div className="progress"><i style={{ width: `${state.progress}%` }} /></div>
      {(state.speed || state.eta) && (
        <small>{state.speed ? `${fmtBytes(state.speed)}/s` : ''}{state.speed && state.eta ? ' · ' : ''}{state.eta ? `${language === 'en-US' ? 'ETA ' : '预计剩余 '}${fmtEta(state.eta)}` : ''}</small>
      )}
    </div>
  );
}

const qrBackgrounds = [
  { id: 'collage', label: 'Collage', src: qrBgCollageUrl },
  { id: 'minimal', label: 'Minimal', src: qrBgMinimalUrl },
  { id: 'punk', label: 'Punk', src: qrBgPunkUrl }
];

function loadQrImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Background image could not be loaded'));
    image.src = src;
  });
}

function drawQrCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawQrRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function drawQrWrappedText(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines = 3) {
  const characters = [...value];
  const lines: string[] = [];
  let line = '';
  characters.forEach((character) => {
    const next = line + character;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = character;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  lines.slice(0, maxLines).forEach((item, index) => ctx.fillText(item, x, y + index * lineHeight));
}

function QrShareModal({ item, close, toast }: { item: Content; close: () => void; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [background, setBackground] = useState(qrBackgrounds[0].src);
  const [customBackground, setCustomBackground] = useState('');
  const [cardUrl, setCardUrl] = useState('');
  const [busy, setBusy] = useState(true);
  const title = item.title || item.attachments?.[0]?.filename || item.slug;
  const fileName = `${title.replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'share'}-qr.png`;

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 1200;
        canvas.height = 675;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas is unavailable');
        const image = await loadQrImage(customBackground || background);
        if (cancelled) return;
        drawQrCover(ctx, image, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,.78)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#111713';
        ctx.textAlign = 'left';
        ctx.font = '800 48px Microsoft YaHei, Segoe UI, sans-serif';
        drawQrWrappedText(ctx, title, 86, 232, 620, 62, 3);
        ctx.fillStyle = '#68716b';
        ctx.font = '500 25px Microsoft YaHei, Segoe UI, sans-serif';
        ctx.fillText(language === 'en-US' ? 'Scan to open this share' : '扫描二维码打开分享', 88, 430);
        ctx.fillStyle = '#bd3822';
        ctx.font = '700 24px ui-monospace, Consolas, monospace';
        ctx.fillText(`${location.origin}/s/${item.slug}`, 88, 480);
        const qrDataUrl = await QRCode.toDataURL(publicLink(item.slug), { errorCorrectionLevel: 'H', margin: 4, width: 220, color: { dark: '#111713', light: '#ffffff' } });
        const qr = await loadQrImage(qrDataUrl);
        const boxX = 908;
        const boxY = 356;
        const boxSize = 264;
        ctx.fillStyle = '#fff';
        drawQrRoundRect(ctx, boxX, boxY, boxSize, boxSize, 22);
        ctx.fill();
        ctx.drawImage(qr, boxX + 22, boxY + 22, 220, 220);
        ctx.fillStyle = '#68716b';
        ctx.font = '600 18px Microsoft YaHei, Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(language === 'en-US' ? 'ShareWorker' : 'ShareWorker', boxX + boxSize / 2, boxY + boxSize + 30);
        if (!cancelled) setCardUrl(canvas.toDataURL('image/png'));
      } catch (error) {
        if (!cancelled) toast((error as Error).message, 'error');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [background, customBackground, item.slug, language, title, toast]);

  useEffect(() => () => { if (customBackground) URL.revokeObjectURL(customBackground); }, [customBackground]);

  async function share() {
    if (!cardUrl || !navigator.share) return toast(language === 'en-US' ? 'System sharing is not available in this browser.' : '当前浏览器不支持系统分享', 'error');
    try {
      const blob = await (await fetch(cardUrl)).blob();
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title, files: [file] });
      } else {
        await navigator.share({ title, text: publicLink(item.slug) });
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') toast((error as Error).message, 'error');
    }
  }

  function chooseCustom(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    if (customBackground) URL.revokeObjectURL(customBackground);
    setCustomBackground(URL.createObjectURL(file));
  }

  return (
    <div className="modal qr-modal" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section className="dialog qr-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-head"><div><h2>{t('qr.title')}</h2><p className="muted">{t('qr.localOnly')}</p></div><button type="button" className="icon" onClick={close} aria-label={t('common.close')} title={t('common.close')}><X size={18} /></button></div>
        <div className="qr-layout">
          <div className="qr-card-preview">{busy || !cardUrl ? <div className="qr-loading">{t('common.loading')}</div> : <img src={cardUrl} alt={title} />}</div>
          <div className="qr-options">
            <strong>{t('qr.background')}</strong>
            <div className="qr-swatches">
              {qrBackgrounds.map((option) => <button type="button" key={option.id} className={`qr-swatch${!customBackground && background === option.src ? ' selected' : ''}`} onClick={() => { setCustomBackground(''); setBackground(option.src); }} title={option.label} aria-label={option.label}><img src={option.src} alt="" /></button>)}
              <label className={`qr-swatch qr-upload-swatch${customBackground ? ' selected' : ''}`} title={t('qr.custom')} aria-label={t('qr.custom')}><Upload size={18} /><input type="file" accept="image/*" onChange={(event) => chooseCustom(event.target.files?.[0])} /></label>
            </div>
            <div className="qr-copy"><strong>{title}</strong><span>{t('qr.tip')}</span></div>
            <div className="qr-actions"><a className="primary" href={cardUrl || '#'} download={fileName} onClick={(event) => { if (!cardUrl) event.preventDefault(); }}><Download size={16} /> {t('qr.save')}</a><button type="button" className="soft" onClick={() => void share()} disabled={!cardUrl}><Share2 size={16} /> {t('qr.share')}</button></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function PublishFile({ toast, username }: { toast: (s: string, k?: Toast['kind']) => void; username: string }) {
  const { t, language } = useI18n();
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public' as Visibility, expire_at: '', max_views: 0, format: 'markdown' });
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Content[]>([]);
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>([]);
  const [progress, setProgress] = useState<UploadProgress>({ visible: false, stage: '', fileName: '', remaining: 0, progress: 0 });
  const queueRef = useRef<BrowserUploadQueue | null>(null);
  const sampleRef = useRef({ at: Date.now(), loaded: 0, speed: 0 });
  const load = () => api<{ items: Content[] }>('/api/contents?type=file').then((r) => setRecent(r.items)).catch((e) => toast(e.message, 'error'));

  function syncUploadProgress(changed?: UploadTask) {
    const tasks = queueRef.current?.getTasks() || (changed ? [changed] : []);
    setUploadTasks(tasks);
    if (!tasks.length) return;
    const total = tasks.reduce((sum, task) => sum + task.size, 0);
    const loaded = tasks.reduce((sum, task) => sum + task.progress.loaded, 0);
    const at = Date.now();
    const elapsed = (at - sampleRef.current.at) / 1000;
    let speed = sampleRef.current.speed;
    if (elapsed >= 0.35) {
      const instant = Math.max(0, loaded - sampleRef.current.loaded) / elapsed;
      speed = speed ? speed * 0.65 + instant * 0.35 : instant;
      sampleRef.current = { at, loaded, speed };
    }
    const remaining = tasks.filter((task) => task.status !== 'complete').length;
    const failed = tasks.some((task) => task.status === 'failed');
    const current = changed || tasks.find((task) => task.status === 'uploading') || tasks[tasks.length - 1];
    const stage = failed
      ? current.error || t('upload.failed')
      : current.status === 'initiating'
        ? (language === 'en-US' ? 'Creating secure upload session' : '正在创建安全上传会话')
        : current.status === 'uploading'
          ? current.mode === 'multipart' ? `${t('upload.inProgress')} ${current.completedParts.length + 1}` : `${t('upload.inProgress')} R2`
          : current.status === 'complete' ? t('upload.complete') : t('upload.waiting');
    setProgress({
      visible: true,
      stage,
      fileName: current.name,
      remaining,
      progress: total ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
      speed,
      eta: speed > 0 ? Math.max(0, total - loaded) / speed : undefined,
      failed
    });
  }

  if (!queueRef.current) {
    queueRef.current = new BrowserUploadQueue({
      api: uploadApi,
      persistence: new IndexedDbUploadPersistence(uploadQueueDatabaseName(username)),
      onProgress: (task) => syncUploadProgress(task)
    });
  }

  async function clearCompletedTasks() {
    const queue = queueRef.current!;
    for (const task of queue.getTasks().filter((item) => item.status === 'complete')) await queue.remove(task.id);
    setUploadTasks(queue.getTasks());
  }

  useEffect(() => {
    void load();
    const queue = queueRef.current!;
    void queue.restore().then(async (restored) => {
      setUploadTasks(restored.tasks);
      const resumable = restored.tasks.some((task) => task.status !== 'complete' && !task.needsFileReselection);
      if (resumable) {
        toast(language === 'en-US' ? 'An unfinished upload was found; resuming from the checkpoint.' : '检测到未完成上传，正在从断点继续');
        await queue.run();
        syncUploadProgress();
        await clearCompletedTasks();
        window.setTimeout(() => void load(), 700);
      }
      if (restored.needsFileReselection.length) toast(language === 'en-US' ? 'Some upload tasks need the original files selected again.' : '有上传任务需要重新选择原文件后继续', 'error');
    }).catch((error) => toast((error as Error).message, 'error'));
  }, []);

  async function acceptFiles(incoming: File[]) {
    const queue = queueRef.current!;
    const oversized = incoming.filter((file) => file.size > MAX_UPLOAD_SIZE);
    if (oversized.length) {
      toast(language === 'en-US' ? `${oversized.length} file(s) exceed the 100 MiB limit.` : `${oversized.length} 个文件超过 100 MiB 限制`, 'error');
      incoming = incoming.filter((file) => file.size <= MAX_UPLOAD_SIZE);
    }
    if (!incoming.length) return;
    const paused = queue.getTasks().filter((task) => task.needsFileReselection);
    const fresh: File[] = [];
    let resumed = 0;
    for (const file of incoming) {
      const match = paused.find((task) => task.name === file.name && task.size === file.size && task.lastModified === file.lastModified);
      if (match) {
        await queue.reselectFile(match.id, file);
        resumed += 1;
      } else {
        fresh.push(file);
      }
    }
    if (fresh.length) setFiles((current) => [...current, ...fresh]);
    if (resumed) {
      toast(language === 'en-US' ? `Resumed ${resumed} upload task(s)` : `已恢复 ${resumed} 个上传任务`);
      await queue.run();
      syncUploadProgress();
      await clearCompletedTasks();
      window.setTimeout(() => void load(), 700);
    }
  }

  async function legacyUpload() {
    const fd = new FormData();
    files.forEach((file) => fd.append('file', file));
    Object.entries({ ...form, expire_at: form.expire_at || '' }).forEach(([key, value]) => fd.append(key, String(value)));
    const result = await new Promise<{ url: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/contents/upload');
      if (token()) xhr.setRequestHeader('Authorization', `Bearer ${token()}`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        setProgress({ visible: true, stage: `${t('upload.inProgress')} Worker`, fileName: files[0].name, remaining: files.length, progress: percent });
      };
      xhr.onload = () => {
        let body: any = {};
        try { body = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { body = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && body.ok !== false) resolve(body);
        else reject(new Error(body.message || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error(t('upload.failed')));
      xhr.send(fd);
    });
    setProgress({ visible: true, stage: t('upload.complete'), fileName: files[files.length - 1].name, remaining: 0, progress: 100 });
    return result;
  }

  async function upload() {
    if (!files.length) return toast(language === 'en-US' ? 'Choose at least one file' : '请选择至少一个文件', 'error');
    setBusy(true);
    sampleRef.current = { at: Date.now(), loaded: 0, speed: 0 };
    setProgress({ visible: true, stage: language === 'en-US' ? 'Preparing secure upload' : '准备安全直传', fileName: files[0].name, remaining: files.length, progress: 0 });
    const queue = queueRef.current!;
    let added: UploadTask[] = [];
    try {
      added = await queue.enqueue(files.map((file, index) => ({
        file,
        clientId: `${Date.now()}-${index}-${file.name}`,
        metadata: { ...form, expire_at: form.expire_at || '' }
      })));
      try {
        await queue.run();
      } catch (error) {
        if (!(error as Error).message.includes('Direct R2 upload is not configured')) throw error;
        for (const task of added) await queue.remove(task.id);
        await legacyUpload();
        toast(language === 'en-US' ? 'Direct upload credentials are unavailable; compatibility upload completed.' : '直传凭证尚未配置，已使用兼容模式完成上传');
      }
      const addedIds = new Set(added.map((task) => task.id));
      const failed = queue.getTasks().filter((task) => addedIds.has(task.id) && task.status === 'failed');
      if (failed.length) throw new Error(failed.map((task) => `${task.name}: ${task.error || t('upload.failed')}`).join(language === 'en-US' ? '; ' : '；'));
      if (!progress.visible || progress.progress < 100) {
        setProgress({ visible: true, stage: language === 'en-US' ? 'Transfer complete; Queue is confirming' : '传输完成，Queue 正在确认', fileName: files[files.length - 1].name, remaining: 0, progress: 100 });
      }
      toast(language === 'en-US' ? 'File transfer complete; the background queue is confirming the content.' : '文件传输完成，后台正在确认内容状态');
      setFiles([]);
      setForm({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public', expire_at: '', max_views: 0, format: 'markdown' });
      await clearCompletedTasks();
      window.setTimeout(() => void load(), 700);
    } catch (err) {
      setProgress((prev) => ({ ...prev, visible: true, stage: (err as Error).message || t('upload.failed'), failed: true }));
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <section className="panel file-panel">
        <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void acceptFiles(Array.from(e.dataTransfer.files)); }}>
          <Upload size={32} />
          <strong>{t('file.drag')}</strong>
          <label className="primary as-label">{t('file.choose')}<input type="file" multiple onChange={(e) => void acceptFiles(Array.from(e.target.files || []))} /></label>
        </div>
        {!!files.length && <div className="file-list">{files.map((f, i) => <div key={`${f.name}-${i}`}><span>{f.name}</span><small>{fmtBytes(f.size)}</small><button className="icon" onClick={() => setFiles(files.filter((_, idx) => idx !== i))}><X size={16} /></button></div>)}</div>}
        {!!uploadTasks.filter((task) => task.needsFileReselection).length && <div className="resume-hint">{t('file.resumeHint')}</div>}
        <OptionsGrid form={form} setForm={setForm} />
        <Field label={t('file.optionalText')}><textarea className="short" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={t('file.mixedPlaceholder')} /></Field>
        <button className="primary" onClick={upload} disabled={busy}><Upload size={16} /> {t('file.startUpload')}</button>
      </section>
      <ContentTable title={t('content.recentFiles')} items={recent} toast={toast} refresh={load} compact />
      <UploadFloating state={progress} onClose={() => setProgress({ visible: false, stage: '', fileName: '', remaining: 0, progress: 0 })} />
    </div>
  );
}

function ContentTable({ title, items, toast, refresh, admin = false, compact = false }: { title: string; items: Content[]; toast: (s: string, k?: Toast['kind']) => void; refresh: () => void; admin?: boolean; compact?: boolean }) {
  const { t, language } = useI18n();
  const [editing, setEditing] = useState<Content | null>(null);
  const [qrItem, setQrItem] = useState<Content | null>(null);
  async function act(item: Content, action: string, method = 'POST') {
    if ((action === 'delete' || action === 'permanent') && !confirm(action === 'permanent' ? (language === 'en-US' ? 'Permanent deletion clears D1 records and R2 objects. Continue?' : '永久删除会清理 D1 和 R2 对象，确认继续？') : (language === 'en-US' ? 'Confirm soft delete?' : '确认软删除？'))) return;
    try {
      const base = admin ? '/api/admin/contents' : '/api/contents';
      await api(`${base}/${item.id}/${action}`, { method });
      toast(language === 'en-US' ? 'Operation completed' : '操作完成');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <section className="panel table-panel">
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="table-scroll">
        <table className={compact ? 'compact' : ''}>
          <thead><tr><th>{t('content.title')}</th><th>{t('content.slugLink')}</th><th>{t('content.type')}</th><th>{t('content.visibility')}</th><th>{t('content.status')}</th><th>{t('content.fileSize')}</th><th>{t('content.views')}</th><th>{t('content.max')}</th><th>{t('content.createdAt')}</th><th>{t('content.expireAt')}</th><th>{t('content.actions')}</th></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.title}</td>
                <td><a href={`/s/${item.slug}`} target="_blank" rel="noreferrer">{item.slug}</a></td>
                <td><Badge text={item.type} /></td>
                <td><Badge text={item.visibility} /></td>
                <td><Badge text={item.status} danger={item.status !== 'active'} /></td>
                <td>{fmtBytes(item.file_size)}</td>
                <td>{item.view_count}</td>
                <td>{item.max_views || (language === 'en-US' ? 'Unlimited' : '无限')}</td>
                <td>{fmtDate(item.created_at)}</td>
                <td>{fmtDate(item.expire_at)}</td>
                <td>
                  <div className="actions">
                    <a className="icon" href={`/s/${item.slug}${admin ? '?admin_preview=1' : ''}`} target="_blank" rel="noreferrer" aria-label={t('content.openLink')} title={t('content.openLink')}><LinkIcon size={16} /></a>
                    <button className="icon" onClick={() => navigator.clipboard.writeText(publicLink(item.slug)).then(() => toast(t('common.copied')))} aria-label={t('content.copyLink')} title={t('content.copyLink')}><Clipboard size={16} /></button>
                    <button className="icon" onClick={() => setQrItem(item)} aria-label={t('content.copyQr')} title={t('content.copyQr')}><QrCode size={16} /></button>
                    <button className="icon" onClick={() => setEditing(item)} aria-label={t('content.edit')} title={t('content.edit')}><Pencil size={16} /></button>
                    {item.status !== 'expired' && <button className="icon" onClick={() => act(item, 'expire')} aria-label={t('content.expire')} title={t('content.expire')}><RefreshCw size={16} /></button>}
                    {(item.status === 'deleted' || item.status === 'expired') && <button className="icon" onClick={() => act(item, 'restore')} aria-label={t('content.restore')} title={t('content.restore')}><RotateCw size={16} /></button>}
                    {item.status !== 'deleted' && <button className="icon danger" onClick={() => act(item, 'delete')} aria-label={t('content.delete')} title={t('content.delete')}><Trash2 size={16} /></button>}
                    {admin && <button className="icon danger" onClick={() => act(item, 'permanent', 'DELETE')} aria-label={t('content.permanentDelete')} title={t('content.permanentDelete')}><X size={16} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={11} className="empty">{t('common.noData')}</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <EditContent item={editing} admin={admin} close={() => setEditing(null)} done={() => { setEditing(null); refresh(); }} toast={toast} />}
      {qrItem && <QrShareModal item={qrItem} close={() => setQrItem(null)} toast={toast} />}
    </section>
  );
}

function EditContent({ item, admin, close, done, toast }: { item: Content; admin: boolean; close: () => void; done: () => void; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [form, setForm] = useState({ title: item.title, remark: item.remark || '', visibility: item.visibility, expire_at: item.expire_at || '', max_views: item.max_views, text_content: item.text_content || '', format: item.format });
  async function save() {
    try {
      await api(`${admin ? '/api/admin/contents' : '/api/contents'}/${item.id}`, { method: 'PATCH', body: JSON.stringify(form) });
      toast(language === 'en-US' ? 'Saved' : '已保存');
      done();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="modal"><div className="dialog">
      <div className="panel-head"><h2>{admin ? (language === 'en-US' ? 'Admin content edit' : 'Admin 修改内容') : (language === 'en-US' ? 'Edit content' : '编辑内容')}</h2><button className="icon" onClick={close} aria-label={t('common.close')}><X /></button></div>
      {!admin && <Field label={t('text.title')}><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>}
      <Field label={t('visibility.label')}><VisibilitySegment value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} /></Field>
      <ExpiryDatePicker className="expire-field" value={form.expire_at || ''} onChange={(expire_at) => setForm({ ...form, expire_at })} />
      <Field label={t('text.maxViews')}><input type="number" min="0" value={form.max_views} onChange={(e) => setForm({ ...form, max_views: Number(e.target.value) })} /></Field>
      {!admin && item.type !== 'file' && <Field label={language === 'en-US' ? 'Text content' : '文本内容'}><textarea className="short" value={form.text_content} onChange={(e) => setForm({ ...form, text_content: e.target.value })} /></Field>}
      {!admin && <Field label={t('text.remark')}><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></Field>}
      <div className="right"><button className="soft" onClick={close}>{t('common.cancel')}</button><button className="primary" onClick={save}>{t('common.save')}</button></div>
    </div></div>
  );
}

function MyContents({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Content[]>([]);
  const [filter, setFilter] = useState({ q: '', type: '', status: '' });
  const load = (next = filter) => {
    const qs = new URLSearchParams(Object.entries(next).filter(([, v]) => v));
    api<{ items: Content[] }>(`/api/contents?${qs}`).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  };
  useEffect(load, [filter.type, filter.status]);
  return (
    <div className="stack no-page-x">
      <section className="panel filters">
        <input placeholder={t('content.searchPlaceholder')} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <FilterMenu
          values={{ type: filter.type, status: filter.status }}
          items={[
            { key: 'type', label: t('filters.type'), options: [{ value: 'text', label: 'text' }, { value: 'file', label: 'file' }, { value: 'mixed', label: 'mixed' }] },
            { key: 'status', label: t('filters.status'), options: [{ value: 'active', label: 'active' }, { value: 'processing', label: t('content.processing') }, { value: 'expired', label: 'expired' }, { value: 'deleted', label: 'deleted' }] }
          ]}
          onChange={(key, value) => { const next = { ...filter, [key]: value }; setFilter(next); load(next); }}
          onClear={() => { const next = { q: '', type: '', status: '' }; setFilter(next); load(next); }}
        />
        <button className="soft" onClick={() => load()}>{t('common.search')}</button>
      </section>
      <ContentTable title={t('content.my')} items={items} toast={toast} refresh={load} />
    </div>
  );
}

function ApiKeys({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState({ remark: '', expire_at: '' });
  const [newKey, setNewKey] = useState('');
  const load = () => api<{ items: any[] }>('/api/api-keys').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);
  async function create() {
    try {
      const res = await api<{ key: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ ...form, expire_at: form.expire_at || null }) });
      setNewKey(res.key);
      toast(language === 'en-US' ? 'API key created. The full value is shown once.' : 'API Key 已创建，完整值仅显示一次');
      setForm({ remark: '', expire_at: '' });
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function mutate(id: string, action: 'rotate' | 'revoke') {
    if (action === 'revoke' && !confirm(language === 'en-US' ? 'Revoke this API key?' : '确认吊销这个 API Key？')) return;
    try {
      const res = await api<any>(`/api/api-keys/${id}/${action}`, { method: 'POST' });
      if (res.key) setNewKey(res.key);
      toast(action === 'rotate' ? (language === 'en-US' ? 'Rotated. The new key is shown once.' : '已旋转，新 key 仅显示一次') : (language === 'en-US' ? 'Revoked' : '已吊销'));
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="stack">
      <section className="panel">
        <div className="options-grid key-options">
          <Field label={t('keys.remark')}><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></Field>
          <ExpiryDatePicker value={form.expire_at} onChange={(expire_at) => setForm({ ...form, expire_at })} />
        </div>
        <div className="actions key-actions"><a className="soft" href="/docs">{t('keys.docs')}</a><button className="primary" onClick={create}><KeyRound size={16} /> {t('keys.create')}</button></div>
        {newKey && <div className="one-time"><strong>{t('keys.fullOnce')}</strong><code>{newKey}</code><button className="soft" onClick={() => navigator.clipboard.writeText(newKey).then(() => toast(language === 'en-US' ? 'Full key copied' : '已复制完整 Key'))}>{t('keys.copy')}</button></div>}
      </section>
      <section className="panel table-panel">
        <div className="table-scroll"><table><thead><tr><th>{t('keys.remark')}</th><th>{t('keys.key')}</th><th>{t('keys.status')}</th><th>{t('keys.expire')}</th><th>{t('keys.lastUsed')}</th><th>{t('keys.calls')}</th><th>{t('keys.actions')}</th></tr></thead><tbody>
          {items.map((k) => <tr key={k.id}><td>{k.remark || '-'}</td><td><code>{k.key_prefix}...{k.key_suffix}</code></td><td><Badge text={k.status} danger={k.status !== 'active'} /></td><td>{fmtDate(k.expire_at)}</td><td>{fmtDate(k.last_used_at)}</td><td>{k.usage_count}</td><td><div className="actions"><button className="icon" title={language === 'en-US' ? 'Rotate' : '旋转'} aria-label={language === 'en-US' ? 'Rotate' : '旋转'} onClick={() => mutate(k.id, 'rotate')}><RotateCw size={16} /></button><button className="icon danger" title={language === 'en-US' ? 'Revoke' : '吊销'} aria-label={language === 'en-US' ? 'Revoke' : '吊销'} onClick={() => mutate(k.id, 'revoke')}><Trash2 size={16} /></button></div></td></tr>)}
          {!items.length && <tr><td colSpan={7} className="empty">{t('keys.empty')}</td></tr>}
        </tbody></table></div>
      </section>
    </div>
  );
}

function UserSettings({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [form, setForm] = useState<any>({ default_visibility: 'public', default_expire_days: 0, default_max_views: 0, default_format: 'markdown', default_endpoint: BASE_URL, default_slug_mode: 'random' });
  useEffect(() => { api<{ item: any }>('/api/settings/cli').then((r) => r.item && setForm(r.item)).catch((e) => toast(e.message, 'error')); }, []);
  async function save() {
    try {
      await api('/api/settings/cli', { method: 'PATCH', body: JSON.stringify(form) });
      toast(language === 'en-US' ? 'User settings saved' : '用户设置已保存');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  const example = `curl -X POST "${form.default_endpoint || BASE_URL}/api/cli/upload-text" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"note","content":"# hello","format":"${form.default_format}","visibility":"${form.default_visibility}","max_views":${form.default_max_views}}'`;
  return (
    <section className="panel">
      <div className="options-grid">
        <Field label={t('settings.defaultVisibility')} className="status-field"><VisibilitySegment value={form.default_visibility} onChange={(default_visibility) => setForm({ ...form, default_visibility })} /></Field>
        <Field label={t('settings.defaultExpireDays')}><input type="number" min="0" value={form.default_expire_days} onChange={(e) => setForm({ ...form, default_expire_days: Number(e.target.value) })} /></Field>
        <Field label={t('settings.defaultMaxViews')}><input type="number" min="0" value={form.default_max_views} onChange={(e) => setForm({ ...form, default_max_views: Number(e.target.value) })} /></Field>
        <Field label={t('settings.defaultMarkdown')}><select value={form.default_format} onChange={(e) => setForm({ ...form, default_format: e.target.value })}><option value="markdown">markdown</option><option value="plain">plain</option></select></Field>
        <Field label={t('settings.endpoint')}><input readOnly value={form.default_endpoint || BASE_URL} /></Field>
        <Field label={t('settings.slugMode')}><select value={form.default_slug_mode} onChange={(e) => setForm({ ...form, default_slug_mode: e.target.value })}><option value="random">{t('settings.random')}</option><option value="custom">{t('settings.custom')}</option></select></Field>
      </div>
      <pre className="code">{example}</pre>
      <button className="primary" onClick={save}>{t('settings.save')}</button>
    </section>
  );
}

function AdminPanel({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState('dashboard');
  const tabs = [['dashboard', t('admin.dashboard')], ['contents', t('admin.contents')], ['users', t('admin.users')], ['logs', t('admin.logs')], ['keys', t('admin.keys')], ['settings', t('admin.settings')]];
  return (
    <div className="stack">
      <div className="tabs">{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'dashboard' && <AdminDashboard toast={toast} />}
      {tab === 'contents' && <AdminContents toast={toast} />}
      {tab === 'users' && <ExpandableAdminTable endpoint="/api/admin/users" title={t('admin.users')} kind="users" toast={toast} />}
      {tab === 'logs' && <ExpandableAdminTable endpoint="/api/admin/access-logs" title={t('admin.logs')} kind="logs" toast={toast} />}
      {tab === 'keys' && <ExpandableAdminTable endpoint="/api/admin/api-keys" title={t('admin.keys')} kind="keys" toast={toast} />}
      {tab === 'settings' && <AdminSettings toast={toast} />}
    </div>
  );
}

function AdminDashboard({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<any>(null);
  useEffect(() => { api('/api/admin/dashboard').then(setData).catch((e) => toast(e.message, 'error')); }, []);
  if (!data) return <section className="panel">{t('common.loading')}</section>;
  const s = data.summary || {};
  const cards = [
    [t('admin.contentCount'), s.total || 0],
    [t('admin.text'), s.text_count || 0],
    [t('admin.file'), s.file_count || 0],
    [t('admin.mixed'), s.mixed_count || 0],
    [t('admin.r2'), fmtBytes(s.r2_bytes || 0)],
    [t('admin.todayViews'), s.today_views || 0],
    [t('admin.todayDownloads'), s.today_downloads || 0],
    [t('admin.expired'), s.expired_count || 0],
    [t('admin.deleted'), s.deleted_count || 0]
  ];
  return (
    <div className="stack">
      <div className="stats">{cards.map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="dash-grid">
        <Chart title={t('admin.topUsers')} rows={data.topUsers.map((r: any) => ({ label: r.username, value: r.count }))} />
        <Chart title={t('admin.typeDistribution')} rows={data.typeDist} />
        <Chart title={t('admin.statusDistribution')} rows={data.statusDist} />
        <Chart title={t('admin.trend')} rows={data.trend.map((r: any) => ({ label: r.day?.slice(5), value: r.value }))} />
      </div>
    </div>
  );
}

function Chart({ title, rows }: { title: string; rows: any[] }) {
  const { t } = useI18n();
  const max = Math.max(1, ...rows.map((r) => Number(r.value || 0)));
  return <section className="panel chart"><h2>{title}</h2>{rows.length ? rows.map((r) => <div className="bar" key={r.label}><span>{r.label}</span><div><i style={{ width: `${(Number(r.value || 0) / max) * 100}%` }} /></div><b>{r.value}</b></div>) : <p className="empty">{t('common.noData')}</p>}</section>;
}

function AdminContents({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Content[]>([]);
  const load = () => api<{ items: Content[] }>('/api/admin/contents').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);
  return <ContentTable title={`${t('nav.admin')} · ${t('admin.contents')}`} items={items} toast={toast} refresh={load} admin />;
}

function adminColumns(kind: string) {
  if (kind === 'users') return ['username', 'total_count', 'text_count', 'file_count', 'last_publish_at', 'role', 'total_file_size'];
  if (kind === 'logs') return ['created_at', 'action', 'slug', 'username', 'ip'];
  return ['owner_username', 'remark', 'key_prefix', 'status', 'last_used_at', 'usage_count'];
}

function labelOf(key: string, language = getInitialLanguage()) {
  const map: Record<string, string> = {
    username: translate(language, 'admin.user'),
    owner_username: translate(language, 'admin.user'),
    total_count: translate(language, 'admin.contentCount'),
    text_count: translate(language, 'admin.text'),
    file_count: translate(language, 'admin.file'),
    last_publish_at: translate(language, 'admin.lastPublish'),
    role: translate(language, 'admin.role'),
    total_file_size: translate(language, 'admin.storage'),
    created_at: translate(language, 'admin.time'),
    action: translate(language, 'admin.action'),
    slug: 'slug',
    ip: translate(language, 'admin.ip'),
    remark: translate(language, 'keys.remark'),
    key_prefix: 'Key',
    status: translate(language, 'keys.status'),
    last_used_at: translate(language, 'admin.lastUsed'),
    usage_count: translate(language, 'admin.calls')
  };
  return map[key] || key;
}

function formatCell(key: string, value: any) {
  if (key.includes('size')) return fmtBytes(Number(value || 0));
  if (key.includes('_at') || key === 'created_at') return fmtDate(value);
  return String(value ?? '-');
}

function ExpandableAdminTable({ endpoint, title, kind, toast }: { endpoint: string; title: string; kind: 'users' | 'logs' | 'keys'; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [items, setItems] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const columns = adminColumns(kind);
  const load = () => api<{ items: any[] }>(endpoint).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { load(); }, [endpoint]);
  const filtered = items.filter((row) => {
    const text = JSON.stringify(row).toLowerCase();
    const qOk = !query || text.includes(query.toLowerCase());
    const sOk = !status || String(row.status || '').toLowerCase() === status;
    return qOk && sOk;
  });
  const exportRows = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const showAction = kind !== 'users';
  return (
    <section className="panel admin-list">
      <div className="admin-tools">
        <div className="searchbox"><Search size={16} /><input placeholder={kind === 'logs' ? t('admin.searchLog') : t('admin.searchUser')} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <FilterMenu
          values={{ status }}
          items={[{ key: 'status', label: t('filters.status'), options: [{ value: 'active', label: 'active' }, { value: 'expired', label: 'expired' }, { value: 'revoked', label: 'revoked' }] }]}
          onChange={(_, value) => setStatus(value)}
          onClear={() => { setStatus(''); setQuery(''); }}
        />
        <button className="soft" onClick={load}><RefreshCw size={16} /> {t('common.refresh')}</button>
        <button className="soft" onClick={exportRows}><Download size={16} /> {t('common.export')}</button>
      </div>
      <div className="admin-table">
        <div className={`admin-row admin-head ${showAction ? '' : 'no-action'}`}>
          <span />
          {columns.map((key) => <strong key={key}>{labelOf(key, language)}</strong>)}
          {showAction && <strong>{t('admin.noAction')}</strong>}
        </div>
        {filtered.map((row, index) => (
          <div className="admin-row-wrap" key={row.id || row.username || index}>
            <div className={`admin-row ${showAction ? '' : 'no-action'}`}>
              <button className="expand-btn" onClick={() => setExpanded({ ...expanded, [index]: !expanded[index] })} aria-label={t('admin.expandDetail')}>
                {expanded[index] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {columns.map((key) => <span key={key}>{key === 'status' ? <Badge text={formatCell(key, row[key])} danger={row[key] !== 'active'} /> : formatCell(key, row[key])}</span>)}
              {showAction && <button className="soft compact-btn" onClick={() => setExpanded({ ...expanded, [index]: !expanded[index] })} title={t('admin.toggleDetail')}>{t('admin.operation')}</button>}
            </div>
            {expanded[index] && (
              <div className="admin-detail">
                {Object.entries(row).map(([key, value]) => <div key={key}><span>{labelOf(key, language)}</span><strong>{formatCell(key, value)}</strong></div>)}
              </div>
            )}
          </div>
        ))}
        {!filtered.length && <div className="empty">{t('common.noData')}</div>}
      </div>
    </section>
  );
}

function AdminSettings({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [item, setItem] = useState<any>(null);
  const [bg, setBg] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [opacity, setOpacity] = useState(0.32);
  useEffect(() => { api<{ item: any }>('/api/admin/settings').then((r) => setItem(r.item)).catch((e) => toast(e.message, 'error')); }, []);
  const loadBg = () => api<{ item: any }>('/api/admin/background').then((r) => { setBg(r.item); setOpacity(Number(r.item?.opacity ?? 0.32)); }).catch((e) => toast(e.message, 'error'));
  useEffect(() => { loadBg(); }, []);
  async function uploadBg() {
    if (!file) return toast(language === 'en-US' ? 'Choose a background image' : '请选择背景图片', 'error');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('opacity', String(opacity));
    try {
      const res = await api<{ item: any }>('/api/admin/background', { method: 'POST', body: fd });
      setBg(res.item);
      setFile(null);
      toast(language === 'en-US' ? 'Background uploaded' : '背景图已上传');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function saveOpacity(next = opacity) {
    try {
      const res = await api<{ item: any }>('/api/admin/background', { method: 'PATCH', body: JSON.stringify({ opacity: next }) });
      setBg(res.item);
      toast(language === 'en-US' ? 'Opacity saved' : '透明度已保存');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function clearBg() {
    if (!confirm(language === 'en-US' ? 'Clear the landing page background?' : '确认清除落地页背景图？')) return;
    try {
      await api('/api/admin/background', { method: 'DELETE' });
      setBg(null);
      toast(language === 'en-US' ? 'Background cleared' : '背景图已清除');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="stack">
      <section className="panel"><h2>{t('admin.settings')}</h2>{item ? <div className="settings-grid">{Object.entries(item).map(([k, v]) => <div key={k}><span>{k}</span><strong>{String(v)}</strong></div>)}</div> : t('common.loading')}</section>
      <section className="panel background-admin">
        <div className="panel-head"><h2>{t('admin.background')}</h2></div>
        <div className="background-grid">
          <div className="background-preview" style={{ backgroundImage: bg?.url ? `url(${bg.url})` : undefined }}>
            {!bg?.url && <span>{t('admin.noBackground')}</span>}
          </div>
          <div className="background-controls">
            <Field label={t('admin.replaceBackground')}><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
            <Field label={t('admin.opacity', { value: Math.round(opacity * 100) })}><input type="range" min="0" max="1" step="0.01" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} onMouseUp={() => saveOpacity()} onTouchEnd={() => saveOpacity()} /></Field>
            <div className="right wrap-actions">
              <button className="primary roomy-btn" onClick={uploadBg}><Upload size={16} /> {t('admin.uploadReplace')}</button>
              <button className="soft roomy-btn" onClick={() => saveOpacity()} disabled={!bg}><RefreshCw size={16} /> {t('admin.saveOpacity')}</button>
              <button className="soft danger roomy-btn" onClick={clearBg} disabled={!bg}><Trash2 size={16} /> {t('admin.clear')}</button>
            </div>
            {bg && <p className="muted">R2: {bg.object_key} / {fmtBytes(bg.size)}</p>}
          </div>
        </div>
      </section>
    </div>
  );
}

function Badge({ text, danger = false }: { text: string; danger?: boolean }) {
  return <span className={`badge ${danger ? 'danger' : ''}`}>{text}</span>;
}

function attachmentUrl(attachmentId: string, mode: 'preview' | 'download' | 'preview-info', mediaTicket = '', adminPreview = false) {
  const qs = new URLSearchParams();
  if (mediaTicket) qs.set('media', mediaTicket);
  if (adminPreview) qs.set('admin_preview', '1');
  const suffix = qs.toString() ? `?${qs}` : '';
  return `/api/attachments/${attachmentId}/${mode}${suffix}`;
}

function attachmentPreviewInfo(attachment: Attachment, adminPreview: boolean): PreviewInfo {
  const kind = previewKind(attachment.filename, attachment.content_type);
  const previewUrl = attachmentUrl(attachment.id, 'preview', attachment.media_ticket, adminPreview);
  return {
    id: attachment.id,
    filename: attachment.filename,
    content_type: attachment.content_type || 'application/octet-stream',
    size: attachment.size,
    kind,
    preview_url: previewUrl,
    download_url: attachmentUrl(attachment.id, 'download', attachment.media_ticket, adminPreview),
    office_embed_url: kind === 'office' && attachment.office_preview_allowed ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(`${location.origin}${previewUrl}`)}` : null
  };
}

function PdfCanvasPreview({ info }: { info: PreviewInfo }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState(t('preview.loading'));
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    setStatus(t('preview.loading'));
    setError('');
    (async () => {
      const pdf = await pdfjsLib.getDocument({
        url: info.preview_url,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.2.108/standard_fonts/'
      }).promise;
      if (cancelled) {
        await (pdf as any).destroy?.();
        return;
      }
      setStatus(`${pdf.numPages} ${t('preview.pages')}`);
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
        const page = await pdf.getPage(pageNo);
        if (cancelled) break;
        const baseViewport = page.getViewport({ scale: 1 });
        const availableWidth = Math.max(280, Math.min(host.clientWidth || 980, 1120) - 32);
        const scale = Math.max(0.45, Math.min(2, availableWidth / baseViewport.width));
        const viewport = page.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas context unavailable');
        const pageWrap = document.createElement('section');
        pageWrap.className = 'pdf-page';
        const label = document.createElement('span');
        label.textContent = `${pageNo} / ${pdf.numPages}`;
        pageWrap.appendChild(label);
        pageWrap.appendChild(canvas);
        host.appendChild(pageWrap);
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0]
        } as any).promise;
      }
      await (pdf as any).destroy?.();
    })().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : t('preview.pdfFailed'));
      }
    });
    return () => {
      cancelled = true;
      host.innerHTML = '';
    };
  }, [info.preview_url]);
  return (
    <div className="pdf-canvas-preview">
      <div className="pdf-status">{error || status}</div>
      {error && <a className="primary" href={info.download_url}><Download size={16} /> {t('common.download')}</a>}
      <div ref={hostRef} className="pdf-pages" />
    </div>
  );
}

function HtmlPageFrame({
  title,
  sourceUrl,
  html,
  sourceText: initialSource
}: {
  title: string;
  sourceUrl?: string;
  html?: string;
  sourceText?: string;
}) {
  const { t, language } = useI18n();
  const frameHostRef = useRef<HTMLDivElement>(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [sourceText, setSourceText] = useState(initialSource || '');
  const [sourceError, setSourceError] = useState('');
  const [loadingSource, setLoadingSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(document.fullscreenElement === frameHostRef.current);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!sourceMode || sourceText || !sourceUrl) return;
    let cancelled = false;
    setLoadingSource(true);
    setSourceError('');
    fetch(sourceUrl, { credentials: 'include' })
      .then(async (response) => {
        if (!response.ok) throw new Error(language === 'en-US' ? `Failed to load source (${response.status})` : `源代码加载失败（${response.status}）`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setSourceText(text);
      })
      .catch((error) => {
        if (!cancelled) setSourceError(error instanceof Error ? error.message : t('preview.sourceError'));
      })
      .finally(() => {
        if (!cancelled) setLoadingSource(false);
      });
    return () => { cancelled = true; };
  }, [sourceMode, sourceText, sourceUrl]);

  async function toggleFullscreen() {
    if (!frameHostRef.current) return;
    if (document.fullscreenElement === frameHostRef.current) {
      await document.exitFullscreen();
    } else {
      await frameHostRef.current.requestFullscreen();
    }
  }

  return (
    <section ref={frameHostRef} className="html-page-frame">
      <div className="preview-inline-toolbar">
        <button type="button" className="soft" onClick={() => setSourceMode((value) => !value)}>
          {sourceMode ? t('preview.view') : t('preview.source')}
        </button>
        <button type="button" className="soft" onClick={() => void toggleFullscreen()}>
          {fullscreen ? t('preview.exitFullscreen') : t('preview.fullscreen')}
        </button>
        <span className="muted">{t('preview.esc')}</span>
      </div>
      {sourceMode ? (
        <pre className="html-source-view" aria-label={`${title} ${language === 'en-US' ? 'source code' : '源代码'}`}>
          {loadingSource ? t('preview.sourceLoading') : sourceError || sourceText}
        </pre>
      ) : (
        <iframe
          className="html-page-frame-content"
          sandbox="allow-scripts"
          src={sourceUrl}
          srcDoc={html}
          title={title}
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

function resolveArchiveAsset(entryName: string, value: string | null, urls: Map<string, string>): string | null {
  if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return value;
  try {
    const rawPath = new URL(value, `https://archive.invalid/${entryName}`).pathname;
    const normalized = normalizeZipEntryName(decodeURIComponent(rawPath.replace(/^\/+/, '')));
    return normalized ? urls.get(normalized) || value : value;
  } catch {
    return value;
  }
}

function rewriteArchiveCss(entryName: string, css: string, urls: Map<string, string>): string {
  const rewriteUrl = (match: string, quote: string, value: string) => {
    const resolved = resolveArchiveAsset(entryName, value, urls);
    return resolved && resolved !== value ? `url(${quote}${resolved}${quote})` : match;
  };
  return css
    .replace(/url\((['"]?)([^)'\"]+)\1\)/gi, rewriteUrl)
    .replace(/(@import\s+)(['"])([^'"]+)\2/gi, (match, prefix, quote, value) => {
      const resolved = resolveArchiveAsset(entryName, value, urls);
      return resolved && resolved !== value ? `${prefix}${quote}${resolved}${quote}` : match;
    });
}

function rewriteArchiveHtml(entryName: string, html: string, urls: Map<string, string>): string {
  if (typeof DOMParser === 'undefined') return html;
  const documentNode = new DOMParser().parseFromString(html, 'text/html');
  const resolve = (value: string | null): string | null => resolveArchiveAsset(entryName, value, urls);
  documentNode.querySelectorAll<HTMLElement>('[src], [href], [poster]').forEach((element) => {
    for (const attribute of ['src', 'href', 'poster']) {
      const value = element.getAttribute(attribute);
      const resolved = resolve(value);
      if (resolved && resolved !== value) element.setAttribute(attribute, resolved);
    }
  });
  documentNode.querySelectorAll<HTMLElement>('[srcset]').forEach((element) => {
    const value = element.getAttribute('srcset') || '';
    const rewritten = value.split(',').map((candidate) => {
      const match = candidate.trim().match(/^(\S+)(\s+.*)?$/);
      if (!match) return candidate;
      const resolved = resolve(match[1]);
      return `${resolved || match[1]}${match[2] || ''}`;
    }).join(', ');
    if (rewritten !== value) element.setAttribute('srcset', rewritten);
  });
  documentNode.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const style = element.getAttribute('style') || '';
    element.setAttribute('style', rewriteArchiveCss(entryName, style, urls));
  });
  documentNode.querySelectorAll('style').forEach((element) => {
    element.textContent = rewriteArchiveCss(entryName, element.textContent || '', urls);
  });
  documentNode.querySelectorAll('base').forEach((element) => element.remove());
  const policy = documentNode.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; img-src blob: data: https:; style-src 'unsafe-inline' blob: https:; font-src blob: data: https:; media-src blob: data: https:; script-src 'unsafe-inline' blob: https:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  documentNode.head.insertBefore(policy, documentNode.head.firstChild);
  return `<!doctype html>${documentNode.documentElement.outerHTML}`;
}

function ZipPagePreview({ info }: { info: PreviewInfo }) {
  const { t, language } = useI18n();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const [entryNames, setEntryNames] = useState<string[]>([]);
  const [selectedEntry, setSelectedEntry] = useState('');
  const [sourceHtml, setSourceHtml] = useState('');
  const [renderedHtml, setRenderedHtml] = useState('');
  const urlsRef = useRef<string[]>([]);
  const entriesRef = useRef<Map<string, Uint8Array>>(new Map());
  const urlsByEntryRef = useRef<Map<string, string>>(new Map());

  useEffect(() => () => {
    urlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  async function openActualPage() {
    if (status === 'loading' || status === 'ready') return;
    setStatus('loading');
    setError('');
    try {
      const response = await fetch(info.preview_url, { credentials: 'include' });
      if (!response.ok) throw new Error(language === 'en-US' ? `Failed to load ZIP (${response.status})` : `压缩包加载失败（${response.status}）`);
      const entries = extractZipEntries(await response.arrayBuffer());
      const htmlEntries = [...entries.keys()].filter((name) => /\.html?$/i.test(name));
      const firstEntry = selectZipHtmlEntry(htmlEntries);
      if (!firstEntry) throw new Error(language === 'en-US' ? 'No HTML entry was found in the ZIP' : '压缩包中没有找到 HTML 入口文件');
      const firstHtml = entries.get(firstEntry);
      if (!firstHtml) throw new Error(language === 'en-US' ? 'The HTML entry could not be read' : 'HTML 入口文件无法读取');
      const urls = new Map<string, string>();
      entries.forEach((data, name) => {
        const copy = data.slice().buffer as ArrayBuffer;
        const url = URL.createObjectURL(new Blob([copy], { type: mimeTypeForArchivePath(name) }));
        urls.set(name, url);
        urlsRef.current.push(url);
      });
      entries.forEach((data, name) => {
        if (!/\.css$/i.test(name)) return;
        const originalUrl = urls.get(name);
        const source = new TextDecoder().decode(data);
        const rewritten = rewriteArchiveCss(name, source, urls);
        const cssUrl = URL.createObjectURL(new Blob([rewritten], { type: 'text/css' }));
        urls.set(name, cssUrl);
        urlsRef.current.push(cssUrl);
        if (originalUrl) URL.revokeObjectURL(originalUrl);
      });
      entriesRef.current = entries;
      urlsByEntryRef.current = urls;
      setEntryNames(htmlEntries);
      setSelectedEntry(firstEntry);
      const source = new TextDecoder().decode(firstHtml);
      setSourceHtml(source);
      setRenderedHtml(rewriteArchiveHtml(firstEntry, source, urls));
      setStatus('ready');
    } catch (error) {
      setError(error instanceof Error ? error.message : t('preview.noActualPage'));
      setStatus('error');
    }
  }

  function changeEntry(entryName: string) {
    const data = entriesRef.current.get(entryName);
    if (!data) return;
    setSelectedEntry(entryName);
    const source = new TextDecoder().decode(data);
    setSourceHtml(source);
    setRenderedHtml(rewriteArchiveHtml(entryName, source, urlsByEntryRef.current));
  }

  if (status === 'ready') {
    return (
      <section className="zip-page-viewer">
        <div className="zip-page-toolbar preview-inline-toolbar">
          <strong>{t('preview.actualPageTitle')}</strong>
          {entryNames.length > 1 && (
            <select value={selectedEntry} onChange={(event) => changeEntry(event.target.value)} aria-label="选择 HTML 入口">
              {entryNames.map((entryName) => <option key={entryName} value={entryName}>{entryName}</option>)}
            </select>
          )}
          <span className="muted">{t('preview.archiveTemp')}</span>
        </div>
        <div className="zip-frame-host">
          <HtmlPageFrame title={selectedEntry} html={renderedHtml} sourceText={sourceHtml} />
        </div>
      </section>
    );
  }
  return (
    <section className="panel narrow zip-preview-panel">
      <h1>{status === 'error' ? t('preview.noActualPage') : t('preview.zipDefault')}</h1>
      <p>{error || t('preview.zipMessage')}</p>
      {status !== 'error' && <button type="button" className="primary" onClick={() => void openActualPage()}>{t('preview.actualPage')}</button>}
      {status === 'error' && <p className="muted">{t('preview.downloadArchive')}</p>}
    </section>
  );
}

function PreviewCanvas({ info, toast }: { info: PreviewInfo; toast?: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const src = info.preview_url;
  const download = info.download_url;
  const name = info.filename;
  return (
    <>
      {info.kind === 'image' && <img src={src} alt={name} />}
      {info.kind === 'video' && <video src={src} controls />}
      {info.kind === 'audio' && <audio src={src} controls />}
      {info.kind === 'pdf' && <PdfCanvasPreview info={info} />}
      {info.kind === 'html' && <HtmlPageFrame title={name} sourceUrl={src} />}
      {info.kind === 'text' && <iframe sandbox="" src={src} title={name} />}
      {info.kind === 'office' && info.office_embed_url && <iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" src={info.office_embed_url} title={name} />}
      {info.kind === 'zip' && <ZipPagePreview info={info} />}
      {info.kind === 'office' && !info.office_embed_url && <section className="panel narrow"><h1>{t('preview.officeUnsupported')}</h1><p>{t('preview.downloadLocal')}</p><DownloadButton url={download}><Download size={16} /> {t('common.download')}</DownloadButton></section>}
      {info.kind === 'download' && <section className="panel narrow"><h1>{t('preview.unsupportedTitle')}</h1><p>{t('preview.downloadLocal')}</p><DownloadButton url={download}><Download size={16} /> {t('common.download')}</DownloadButton></section>}
    </>
  );
}

function AttachmentPreview({ attachment, password, adminPreview, toast }: { attachment: Attachment; password: string; adminPreview: boolean; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const info = attachmentPreviewInfo(attachment, adminPreview);
  const preview = info.preview_url;
  const download = info.download_url;
  const kind = previewKind(attachment.filename, attachment.content_type);
  return (
    <div className="attachment-card">
      <div className="attachment-head">
        <FileUp size={18} />
        <strong>{attachment.filename}</strong>
        <span>{fmtBytes(attachment.size)}</span>
        <DownloadButton url={download} className="soft download-btn attachment-download"><Download size={16} /> {t('common.download')}</DownloadButton>
      </div>
      {kind === 'image' && <img className="file-preview image-preview" src={preview} alt={attachment.filename} />}
      {kind === 'video' && <video className="file-preview" controls src={preview} />}
      {kind === 'audio' && <audio className="audio-preview" controls src={preview} />}
      {kind === 'text' && <iframe sandbox="" className="file-preview frame-preview" src={preview} title={attachment.filename} />}
      {kind === 'download' && (
        <div className="preview-actions">
          <p className="muted">{t('preview.downloadable')}</p>
        </div>
      )}
    </div>
  );
}

function FilePreviewPage({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t } = useI18n();
  const attachmentId = location.pathname.split('/preview/')[1]?.split('/')[0] || '';
  const qs = new URLSearchParams(location.search);
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ item: PreviewInfo }>(attachmentUrl(attachmentId, 'preview-info', qs.get('media') || '', qs.get('admin_preview') === '1'))
      .then((res) => setInfo(res.item))
      .catch((err) => setError((err as Error).message));
  }, [attachmentId]);
  if (error) return <div className="preview-page preview-message"><section className="panel narrow"><h1>{t('preview.unsupportedTitle')}</h1><p>{error}</p></section></div>;
  if (!info) return <div className="preview-page preview-message"><section className="panel narrow">{t('preview.loading')}</section></div>;
  const src = info.preview_url;
  const download = info.download_url;
  const name = info.filename;
  return (
    <div className="preview-page">
      <header className="preview-topbar">
        <strong>{name}</strong>
        <span>{fmtBytes(info.size)} / {info.content_type}</span>
        <LanguageSwitcher />
        <DownloadButton url={download}><Download size={16} /> {t('common.download')}</DownloadButton>
      </header>
      <main className={`preview-main ${info.kind === 'pdf' ? 'pdf-preview-main' : ''}`}>
        {info.kind === 'image' && <img src={src} alt={name} />}
        {info.kind === 'video' && <video src={src} controls />}
        {info.kind === 'audio' && <audio src={src} controls />}
        {info.kind === 'pdf' && <PdfCanvasPreview info={info} />}
        {info.kind === 'html' && <HtmlPageFrame title={name} sourceUrl={src} />}
        {info.kind === 'text' && <iframe sandbox="" src={src} title={name} />}
        {info.kind === 'office' && info.office_embed_url && <iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups" referrerPolicy="no-referrer" src={info.office_embed_url} title={name} />}
        {info.kind === 'zip' && <ZipPagePreview info={info} />}
        {info.kind === 'office' && !info.office_embed_url && <section className="panel narrow"><h1>{t('preview.officeUnsupported')}</h1><p>{t('preview.downloadLocal')}</p><DownloadButton url={download}><Download size={16} /> {t('common.download')}</DownloadButton></section>}
        {info.kind === 'download' && <section className="panel narrow"><h1>{t('preview.unsupportedTitle')}</h1><p>{t('preview.unsupported')}</p><DownloadButton url={download}><Download size={16} /> {t('common.download')}</DownloadButton></section>}
      </main>
    </div>
  );
}

function SharePreviewPage({ item, password, adminPreview, toast }: { item: Content; password: string; adminPreview: boolean; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const attachments = item.attachments || [];
  const routeFile = new URLSearchParams(location.search).get('file') || '';
  const firstTarget = routeFile || (item.text_content ? 'text' : attachments[0]?.id || '');
  const [selected, setSelected] = useState(firstTarget);
  useEffect(() => { setSelected(firstTarget); }, [item.id, firstTarget]);
  const selectedAttachment = attachments.find((a) => a.id === selected) || (!item.text_content ? attachments[0] : undefined);
  const showText = selected === 'text' || (!selectedAttachment && !!item.text_content);
  const info = selectedAttachment ? attachmentPreviewInfo(selectedAttachment, adminPreview) : null;
  const backQs = new URLSearchParams();
  if (adminPreview) backQs.set('admin_preview', '1');
  if (item.share_ticket) backQs.set('access', item.share_ticket);
  const backUrl = `/s/${item.slug}${backQs.toString() ? `?${backQs}` : ''}`;
  return (
    <div className="preview-page share-preview-page">
      <header className="preview-topbar share-preview-topbar">
        <a className="soft back-link" href={backUrl}>{language === 'en-US' ? 'Back' : '返回'}</a>
        <div className="preview-title">
          <strong>{showText ? item.title : info?.filename}</strong>
          <span>{item.visibility} / {item.type} / {fmtBytes(info?.size || item.file_size)}</span>
        </div>
        <LanguageSwitcher />
        {(attachments.length + (item.text_content ? 1 : 0)) > 1 && (
          <select value={showText ? 'text' : selectedAttachment?.id || ''} onChange={(e) => setSelected(e.target.value)}>
            {item.text_content && <option value="text">{t('share.text')}</option>}
            {attachments.map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
          </select>
        )}
        {info ? <DownloadButton url={info.download_url}><Download size={16} /> {t('common.download')}</DownloadButton> : <button className="soft" onClick={() => navigator.clipboard.writeText(location.href).then(() => toast(t('common.copied')))}>{t('common.copy')}</button>}
      </header>
      <main className={`preview-main ${showText ? 'text-preview-main' : ''} ${info?.kind === 'pdf' ? 'pdf-preview-main' : ''}`}>
        {showText ? (
          <TextPreviewBox html={renderTextHtml(item.format, item.text_content || '')} rawText={item.text_content || ''} />
        ) : info ? <PreviewCanvas info={info} toast={toast} /> : <section className="panel narrow">{t('preview.noPreview')}</section>}
      </main>
    </div>
  );
}

function parseShareRoute() {
  const parts = location.pathname.split('/').filter(Boolean);
  return {
    slug: parts[0] === 's' ? parts[1] || '' : '',
    preview: parts[0] === 's' && parts[2] === 'preview'
  };
}

function NoteComposer({ mode, replyingTo, onCancel, onSubmit, disabled }: { mode: 'comment' | 'memo'; replyingTo?: ShareNote | null; onCancel?: () => void; onSubmit: (body: string, visibility: 'public' | 'private', parentId?: string | null) => Promise<void>; disabled?: boolean }) {
  const { t } = useI18n();
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>(mode === 'memo' ? 'private' : 'public');
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await onSubmit(body, visibility, replyingTo?.id || null);
      setBody('');
      if (onCancel) onCancel();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`note-composer ${replyingTo ? 'replying' : ''}`}>
      {replyingTo && <div className="reply-target">{t('notes.reply')} @{replyingTo.author.username}</div>}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={mode === 'memo' ? t('notes.writeMemo') : t('notes.writeComment')} disabled={disabled || busy} />
      <div className="note-compose-actions">
        {mode === 'comment' && (
          <div className="segmented note-visibility">
              <button type="button" className={visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')}>{t('notes.allVisible')}</button>
              <button type="button" className={visibility === 'private' ? 'on' : ''} onClick={() => setVisibility('private')}>{t('notes.private')}</button>
          </div>
        )}
        {onCancel && <button type="button" className="soft" onClick={onCancel}>{t('notes.cancel')}</button>}
        <button type="button" className="primary" onClick={submit} disabled={disabled || busy || !body.trim()}>{mode === 'memo' ? t('notes.saveMemo') : t('notes.send')}</button>
      </div>
    </div>
  );
}

function NoteItem({ note, mode, onReply, activeReply, clearReply, submit, canManage, onDelete }: { note: ShareNote; mode: 'comment' | 'memo'; onReply: (n: ShareNote) => void; activeReply: string; clearReply: () => void; submit: (body: string, visibility: 'public' | 'private', parentId?: string | null) => Promise<void>; canManage: boolean; onDelete: (noteId: string) => Promise<void> }) {
  const { t, language } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article className="note-item">
      <img className="note-avatar" src={avatarSrc(note.author.avatar_url)} alt={`${note.author.username} 头像`} />
      <div className="note-body">
        <header>
          <strong>{note.author.name || note.author.username}</strong>
          <span>@{note.author.username}</span>
          <span>{fmtDate(note.created_at)}</span>
          <span>IP: {note.ip_region || (language === 'en-US' ? 'Unknown region' : '未知地区')}</span>
          {note.visibility === 'private' && <b>{t('notes.private')}</b>}
        </header>
        {canManage && (
          <div className="note-menu-wrap">
            <button type="button" className="icon note-menu-btn" aria-label={t('notes.commentActions')} onClick={() => setMenuOpen(true)}><MoreVertical size={16} /></button>
            {menuOpen && (
              <>
                <button type="button" className="note-menu-scrim" aria-label={t('notes.closeMenu')} onClick={() => setMenuOpen(false)} />
                <div className="note-menu">
                  <button type="button" className="danger" onClick={() => { setMenuOpen(false); void onDelete(note.id); }}>{t('notes.delete')}</button>
                </div>
              </>
            )}
          </div>
        )}
        <p>{note.body}</p>
        {mode === 'comment' && <button type="button" className="note-reply" onClick={() => onReply(note)}>{t('notes.reply')}</button>}
        {activeReply === note.id && <NoteComposer mode="comment" replyingTo={note} onCancel={clearReply} onSubmit={submit} />}
        {!!note.replies?.length && (
          <div className="note-replies">
            {note.replies.map((reply) => <NoteItem key={reply.id} note={reply} mode={mode} onReply={onReply} activeReply={activeReply} clearReply={clearReply} submit={submit} canManage={canManage} onDelete={onDelete} />)}
          </div>
        )}
      </div>
    </article>
  );
}

function ShareNotesPanel({ item, password, adminPreview, toast }: { item: Content; password: string; adminPreview: boolean; toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const [notes, setNotes] = useState<ShareNote[]>([]);
  const [mode, setMode] = useState<'comment' | 'memo'>(item.visibility === 'private' ? 'memo' : 'comment');
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [replying, setReplying] = useState('');
  const qs = () => {
    const params = new URLSearchParams();
    if (adminPreview) params.set('admin_preview', '1');
    return params.toString() ? `?${params}` : '';
  };
  async function loadNotes() {
    try {
      setError('');
      const res = await api<{ mode: 'comment' | 'memo'; items: ShareNote[] }>(`/api/share/${item.slug}/notes${qs()}`, { headers: shareHeaders(password, item.share_ticket) });
      setMode(res.mode);
      setNotes(res.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => {
    if (token()) api<{ user: User }>('/api/me').then((r) => setMe(r.user)).catch(() => setMe(null));
  }, []);
  useEffect(() => { void loadNotes(); }, [item.id, password, adminPreview]);
  async function submit(body: string, visibility: 'public' | 'private', parentId?: string | null) {
    if (!token()) {
      login();
      return;
    }
    const res = await api<{ items: ShareNote[] }>(`/api/share/${item.slug}/notes${qs()}`, {
      method: 'POST',
      headers: shareHeaders(password, item.share_ticket),
      body: JSON.stringify({ body, visibility, parent_id: parentId || null })
    });
    setNotes(res.items);
    setReplying('');
    toast(mode === 'memo' ? (language === 'en-US' ? 'Memo saved' : '备忘已保存') : (language === 'en-US' ? 'Comment sent' : '评论已发送'));
  }
  async function deleteNote(noteId: string) {
    if (!confirm(language === 'en-US' ? 'Delete this comment?' : '确认删除这条评论？')) return;
    const res = await api<{ items: ShareNote[] }>(`/api/share/${item.slug}/notes/${noteId}${qs()}`, { method: 'DELETE', headers: shareHeaders(password, item.share_ticket) });
    setNotes(res.items);
    toast(mode === 'memo' ? (language === 'en-US' ? 'Memo deleted' : '备忘已删除') : (language === 'en-US' ? 'Comment deleted' : '评论已删除'));
  }
  const canMemo = mode !== 'memo' || me?.username === item.owner_username;
  const canManageNotes = me?.username === item.owner_username;
  return (
    <section className="panel notes-panel">
      <div className="notes-head">
        <div>
          <h2>{mode === 'memo' ? t('notes.memo') : t('notes.comments')}</h2>
          <p>{mode === 'memo' ? t('notes.memoHint') : t('notes.commentHint')}</p>
        </div>
        <span>{notes.length}</span>
      </div>
      {error && <div className="note-empty">{error}</div>}
      {mode === 'memo' && !canMemo ? (
        <div className="note-empty">{t('notes.memoOwnerOnly')}</div>
      ) : (
        <>
          <NoteComposer mode={mode} onSubmit={submit} disabled={mode === 'memo' && !canMemo} />
          <div className="notes-list">
            {notes.map((note) => <NoteItem key={note.id} note={note} mode={mode} onReply={(target) => setReplying(target.id)} activeReply={replying} clearReply={() => setReplying('')} submit={submit} canManage={canManageNotes} onDelete={deleteNote} />)}
            {!notes.length && !error && <div className="note-empty">{mode === 'memo' ? t('notes.emptyMemo') : t('notes.emptyComments')}</div>}
          </div>
        </>
      )}
    </section>
  );
}

function ContentPreviewPage({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { t, language } = useI18n();
  const { slug, preview } = parseShareRoute();
  const [password, setPassword] = useState('');
  const [item, setItem] = useState<Content | null>(null);
  const [error, setError] = useState('');
  const adminPreview = new URLSearchParams(location.search).get('admin_preview') === '1';
  async function load(pass = password) {
    try {
      setError('');
      const qs = new URLSearchParams();
      if (adminPreview) qs.set('admin_preview', '1');
      const existingAccess = new URLSearchParams(location.search).get('access') || '';
      const res = await api<{ item: Content }>(`/api/share/${slug}${qs.toString() ? `?${qs}` : ''}`, { headers: shareHeaders(pass, existingAccess) });
      setItem(res.item);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => { load(''); }, [slug]);
  if (error && !item) {
    const needsPassword = error.includes('Password') || error.includes('密码');
    return (
      <div className="share-shell">
        <section className="panel share-error">
          <h1>{t('share.noAccess')}</h1>
          <p>{error}</p>
          {needsPassword ? (
            <div className="password-row">
              <input type="password" placeholder={t('share.password')} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="primary" onClick={() => load(password)}>{t('share.submitPassword')}</button>
            </div>
          ) : token() ? null : <button className="primary" onClick={login}>{t('share.login')}</button>}
        </section>
      </div>
    );
  }
  if (!item) return <div className="share-shell"><section className="panel narrow">{t('preview.loading')}</section></div>;
  if (preview) return <SharePreviewPage item={item} password={password} adminPreview={adminPreview} toast={toast} />;
  const previewQs = new URLSearchParams();
  if (adminPreview) previewQs.set('admin_preview', '1');
  if (item.share_ticket) previewQs.set('access', item.share_ticket);
  if (item.attachments?.[0]) previewQs.set('file', item.attachments[0].id);
  const previewUrl = `/s/${item.slug}/preview${previewQs.toString() ? `?${previewQs}` : ''}`;
  return (
    <div className="share-shell">
      <header className="share-top">
        <div>
          <span className="eyebrow">{item.visibility} / {item.type}</span>
          <h1>{item.title}</h1>
          <p>{fmtDate(item.created_at)} · {item.max_views ? t('share.viewsMax', { current: item.view_count, max: item.max_views }) : t('share.viewCount', { count: item.view_count })}</p>
        </div>
        <div className="share-top-actions">
          <LanguageSwitcher />
          {!preview && <a className="primary" href={previewUrl}>{t('common.openPreview')}</a>}
          <button className="soft" onClick={() => navigator.clipboard.writeText(location.href).then(() => toast(t('common.copied')))}>{t('common.copy')}</button>
        </div>
      </header>
      <main className={`share-layout ${preview ? 'preview-mode' : ''}`}>
        <div className="share-main-column">
          {item.text_content && (
            <section className="panel share-text">
              <h2>{t('share.text')}</h2>
              <TextPreviewBox html={renderTextHtml(item.format, item.text_content)} rawText={item.text_content} />
            </section>
          )}
          {!!item.attachments?.length && (
            <section className="panel share-files">
              <h2>{t('share.files')}</h2>
              {item.attachments.map((a) => <AttachmentPreview key={a.id} attachment={a} password={password} adminPreview={adminPreview} toast={toast} />)}
            </section>
          )}
          <ShareNotesPanel item={item} password={password} adminPreview={adminPreview} toast={toast} />
        </div>
      </main>
    </div>
  );
}

function LandingPage({ background }: { background: any }) {
  const { t } = useI18n();
  const style = background?.url
    ? ({
        '--landing-bg': `url(${background.url})`,
        '--landing-opacity': String(background.opacity ?? 0.32)
      } as React.CSSProperties)
    : undefined;
  return (
    <div className={`login landing ${background?.url ? 'with-bg' : ''}`} style={style}>
      <div className="landing-language"><LanguageSwitcher /></div>
      <section className="landing-hero">
        <div className="landing-copy">
          <h1>ShareWorker</h1>
          <div className="landing-actions">
            <button className="primary" onClick={login}><UserRound size={18} /> {t('landing.login')}</button>
            <a className="soft" href="/face-transfer"><ScanLine size={18} /> {t('landing.face')}</a>
          </div>
        </div>
        <div className="landing-console" aria-label={t('landing.cli')}>
          <div><span /> <span /> <span /></div>
          <pre>{`curl -X POST ${BASE_URL}/api/cli/upload-text
  -H "Authorization: Bearer <API_KEY>"
  -d '{"format":"markdown","visibility":"public"}'`}</pre>
        </div>
        <div className="landing-metrics">
          <div><strong>SSO</strong><span>{t('landing.sso')}</span></div>
          <div><strong>R2</strong><span>{t('landing.r2')}</span></div>
          <div><strong>D1</strong><span>{t('landing.d1')}</span></div>
        </div>
      </section>
    </div>
  );
}

function ApiDocsPage() {
  const { t } = useI18n();
  return (
    <div className="share-shell docs-page">
      <header className="share-top">
        <div><p>ShareWorker</p><h1>API Docs</h1></div>
        <div className="share-top-actions"><LanguageSwitcher /><a className="soft" href="/">{t('common.backHome')}</a></div>
      </header>
      <main className="share-layout">
        <TextPreviewBox className="docs-preview" html={renderTextHtml('markdown', apiDocsMarkdown)} rawText={apiDocsMarkdown} />
      </main>
    </div>
  );
}

function FaceTransferPublicPage({ toast }: { toast: (text: string, kind?: 'ok' | 'error') => void }) {
  const { t } = useI18n();
  return (
    <div className="share-shell face-transfer-public">
      <header className="share-top">
        <div><p>ShareWorker</p><h1>{t('public.transfer')}</h1></div>
        <div className="share-top-actions"><LanguageSwitcher /><a className="soft" href="/">{t('common.backHome')}</a></div>
      </header>
      <main className="face-public-main">
        <FaceTransfer toast={toast} />
      </main>
    </div>
  );
}

function App() {
  const { t } = useI18n();
  const { toasts, push } = useToast();
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState('text');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [landingBackground, setLandingBackground] = useState<any>(null);
  const [dark, setDark] = useState(localStorage.getItem('theme') === 'dark');
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); localStorage.setItem('theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    if (location.pathname === '/sso-callback') {
      const t = new URLSearchParams(location.search).get('token');
      if (t) {
        api<{ user: User; token: string }>('/api/sso-callback', { method: 'POST', body: JSON.stringify({ token: t }) })
          .then((r) => { localStorage.setItem('sso_token', r.token); location.href = '/'; })
          .catch((e) => push(e.message, 'error'));
      }
      return;
    }
    if (location.pathname === '/') {
      api<{ item: { landing_background?: any } }>('/api/public/settings').then((r) => setLandingBackground(r.item?.landing_background || null)).catch(() => {});
      if (token()) api<{ user: User }>('/api/me').then(async (r) => {
        await deleteUploadDatabase('content-share-upload-queue');
        setUser(r.user);
      }).catch(() => setUser(null));
    }
  }, []);
  if (location.pathname.startsWith('/preview/')) return <><FilePreviewPage toast={push} /><Toasts items={toasts} /></>;
  if (location.pathname.startsWith('/s/')) return <><ContentPreviewPage toast={push} /><Toasts items={toasts} /></>;
  if (location.pathname === '/docs') return <><ApiDocsPage /><Toasts items={toasts} /></>;
  if (location.pathname === '/face-transfer') return <><FaceTransferPublicPage toast={push} /><Toasts items={toasts} /></>;
  if (location.pathname === '/sso-callback') return <div className="public-page"><section className="panel narrow">{t('sso.completing')}</section><Toasts items={toasts} /></div>;
  if (!user) return <><LandingPage background={landingBackground} /><Toasts items={toasts} /></>;
  const titleMap: Record<string, string> = { text: t('nav.publishText'), file: t('nav.publishFile'), face: t('nav.faceTransfer'), mine: t('nav.myContent'), keys: t('nav.apiKeys'), settings: t('nav.settings'), admin: t('nav.admin') };
  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar page={page} setPage={setPage} user={user} open={sidebarOpen} setOpen={setSidebarOpen} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />
      {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label={t('nav.closeSidebar')} onClick={() => setSidebarOpen(false)} />}
      <main>
        <Header title={titleMap[page]} onMenu={() => setSidebarOpen(true)} dark={dark} setDark={setDark} user={user} />
        <div className="content">
          {page === 'text' && <PublishText toast={push} />}
          {page === 'file' && <PublishFile toast={push} username={user.username} />}
          {page === 'face' && <FaceTransfer toast={push} />}
          {page === 'mine' && <MyContents toast={push} />}
          {page === 'keys' && <ApiKeys toast={push} />}
          {page === 'settings' && <UserSettings toast={push} />}
          {page === 'admin' && user.role === 'admin' && <AdminPanel toast={push} />}
        </div>
      </main>
      <Toasts items={toasts} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<I18nProvider><App /></I18nProvider>);
