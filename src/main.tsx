import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import { marked } from 'marked';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import defaultAvatarUrl from './assets/default-avatar.png';
import {
  ChevronDown,
  ChevronRight,
  Clipboard,
  Download,
  FileUp,
  KeyRound,
  Link as LinkIcon,
  LogOut,
  Menu,
  MoreVertical,
  Moon,
  Pencil,
  QrCode,
  RefreshCw,
  RotateCw,
  Search,
  Settings,
  Shield,
  Sun,
  TextCursorInput,
  Trash2,
  Upload,
  UserRound,
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
  attachments?: Attachment[];
};
type Attachment = { id: string; filename: string; content_type: string; size: number };
type Toast = { id: number; text: string; kind?: 'ok' | 'error' };
type UploadProgress = { visible: boolean; stage: string; fileName: string; remaining: number; progress: number };
type PreviewInfo = { id: string; filename: string; content_type: string; size: number; kind: string; preview_url: string; download_url: string; office_embed_url?: string | null };
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
const visibilityOptions: Array<{ value: Visibility; label: string }> = [
  { value: 'public', label: '公开' },
  { value: 'internal', label: '内部' },
  { value: 'private', label: '私有' }
];

function token() {
  return localStorage.getItem('sso_token') || '';
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

function fmtDate(v?: string | null) {
  return v ? new Date(v).toLocaleString() : '永久';
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

function authCenterProfile(user: User) {
  return `${SSO_URL}/${encodeURIComponent(user.uuid || user.id || user.username)}`;
}

function escapeHtml(input: string) {
  return input.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
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
  const index = visibilityOptions.findIndex((item) => item.value === value);
  return (
    <div className="visibility-segment" role="radiogroup" aria-label="发布状态">
      <i style={{ transform: `translateX(${Math.max(index, 0) * 100}%)` }} />
      {visibilityOptions.map((item) => (
        <button type="button" key={item.value} className={value === item.value ? 'on' : ''} onClick={() => onChange(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Sidebar({ page, setPage, user, open, setOpen, collapsed, setCollapsed }: { page: string; setPage: (v: string) => void; user: User; open: boolean; setOpen: (v: boolean) => void; collapsed: boolean; setCollapsed: (v: boolean) => void }) {
  const items = [
    ['text', '发布文本', TextCursorInput],
    ['file', '发布文件', FileUp],
    ['mine', '我的内容', Clipboard],
    ['keys', 'API Key', KeyRound],
    ['settings', '用户设置', Settings]
  ] as const;
  return (
    <aside className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand">
        <span>ShareWorker</span>
        <button className="icon sidebar-toggle" onClick={() => { if (open) { setOpen(false); return; } setCollapsed(!collapsed); }} aria-label={open ? '关闭侧栏' : collapsed ? '展开侧栏' : '折叠侧栏'} title={open ? '关闭侧栏' : collapsed ? '展开侧栏' : '折叠侧栏'}><Menu size={18} /></button>
      </div>
      <nav>
        {items.map(([id, label, Icon]) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); setOpen(false); }} title={label}>
            <Icon size={18} /> <span>{label}</span>
          </button>
        ))}
        {user.role === 'admin' && (
          <button className={page === 'admin' ? 'active' : ''} onClick={() => { setPage('admin'); setOpen(false); }} title="Admin 面板">
            <Shield size={18} /> <span>Admin 面板</span>
          </button>
        )}
      </nav>
      <div className="side-foot">auth-center SSO</div>
    </aside>
  );
}

function Header({ title, onMenu, dark, setDark, user }: { title: string; onMenu: () => void; dark: boolean; setDark: (v: boolean) => void; user: User }) {
  const [open, setOpen] = useState(false);
  const logout = () => {
    localStorage.removeItem('sso_token');
    location.href = `${SSO_URL}/logout?redirect=${encodeURIComponent(location.origin)}`;
  };
  return (
    <header className="topbar">
      <button className="icon mobile-only" onClick={onMenu} aria-label="打开侧栏"><Menu /></button>
      <h1>{title}</h1>
      <div className="top-actions">
        <button className="soft theme-toggle" onClick={() => setDark(!dark)}>{dark ? <Sun size={16} /> : <Moon size={16} />} {dark ? '浅色' : '暗色'}</button>
        <div className="user-area">
          <button className="avatar-btn" onClick={() => setOpen(!open)} aria-label="打开用户菜单">
            <img src={avatarSrc(user.avatar_url)} alt={`${user.username} 头像`} />
          </button>
          <span className="user-name">{user.name || user.username}</span>
          <button className="icon logout-icon" onClick={logout} aria-label="退出登录"><LogOut size={18} /></button>
          {open && (
            <>
              <button type="button" className="user-menu-scrim" aria-label="关闭用户菜单" onClick={() => setOpen(false)} />
              <div className="user-menu">
                <div className="user-card">
                  <img src={avatarSrc(user.avatar_url)} alt={`${user.username} 头像`} />
                  <div>
                    <strong>{user.name || user.username}</strong>
                    <small>{user.username}</small>
                  </div>
                </div>
                <dl>
                  <div><dt>身份</dt><dd>{user.role}</dd></div>
                  <div><dt>UUID</dt><dd>{user.uuid || user.id || '-'}</dd></div>
                </dl>
                <a className="soft menu-link" href={authCenterProfile(user)} target="_blank" rel="noreferrer">打开 auth-center 详情</a>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function MarkdownToolbar({ textareaRef, content, setContent }: { textareaRef: React.RefObject<HTMLTextAreaElement>; content: string; setContent: (v: string) => void }) {
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
    <div className="markdown-toolbar" aria-label="Markdown 格式工具栏">
      <button type="button" onClick={() => apply('**', '**', '加粗文字')}>B</button>
      <button type="button" onClick={() => apply('*', '*', '斜体文字')}><i>I</i></button>
      <button type="button" onClick={() => insertLine('\n## 标题\n')}>H</button>
      <button type="button" onClick={() => apply('[', '](https://)', '链接文字')}>link</button>
      <button type="button" onClick={() => apply('`', '`', 'code')}>code</button>
      <button type="button" onClick={() => insertLine('\n| 列 A | 列 B |\n| --- | --- |\n| 内容 | 内容 |\n')}>table</button>
      <button type="button" onClick={() => insertLine('\n- 列表项\n')}>list</button>
      <button type="button" onClick={() => insertLine('\n> 引用\n')}>quote</button>
    </div>
  );
}

function PublishText({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [format, setFormat] = useState<'markdown' | 'plain'>('plain');
  const [mobileTab, setMobileTab] = useState<'pure' | 'preview'>('pure');
  const [form, setForm] = useState({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public' as Visibility, expire_at: '', max_views: 0 });
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const preview = useMemo(() => format === 'markdown' ? marked.parse(form.content || '') : `<pre>${escapeHtml(form.content || '')}</pre>`, [format, form.content]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ url: string }>('/api/contents/text', { method: 'POST', body: JSON.stringify({ ...form, format, expire_at: form.expire_at || null }) });
      toast(`已创建：${res.url}`);
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
          <button type="button" className={format === 'markdown' ? 'on' : ''} onClick={() => setFormat('markdown')}>Markdown</button>
          <button type="button" className={format === 'plain' ? 'on' : ''} onClick={() => setFormat('plain')}>普通文本</button>
        </div>
        <button className="primary" disabled={busy || !form.content.trim()}><Upload size={16} /> 创建发布</button>
      </div>
      {format === 'markdown' ? (
        <>
          <MarkdownToolbar textareaRef={textareaRef} content={form.content} setContent={(content) => setForm({ ...form, content })} />
          <div className="mobile-tabs pure-tabs">
            <button type="button" className={mobileTab === 'pure' ? 'on' : ''} onClick={() => setMobileTab('pure')}>pure</button>
            <button type="button" className={mobileTab === 'preview' ? 'on' : ''} onClick={() => setMobileTab('preview')}>preview</button>
          </div>
          <div className="editor-grid">
            <textarea ref={textareaRef} className={mobileTab === 'pure' ? '' : 'mobile-hide'} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder={'# 标题\n\n写点什么...'} />
            <div className={`preview ${mobileTab === 'preview' ? '' : 'mobile-hide'}`} dangerouslySetInnerHTML={{ __html: preview }} />
          </div>
        </>
      ) : (
        <textarea className="plain-editor" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="输入普通文本..." />
      )}
      <OptionsGrid form={form} setForm={setForm} />
    </form>
  );
}

function OptionsGrid({ form, setForm }: { form: any; setForm: (v: any) => void }) {
  return (
    <div className="options-grid">
      <Field label="标题"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="可选标题" /></Field>
      <Field label="自定义 slug"><input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} placeholder="留空随机" /></Field>
      <Field label="访问密码"><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="可选" /></Field>
      <Field label="过期时间"><input type="datetime-local" value={form.expire_at} onChange={(e) => setForm({ ...form, expire_at: e.target.value })} /></Field>
      <Field label="最大打开次数"><input type="number" min="0" value={form.max_views} onChange={(e) => setForm({ ...form, max_views: Number(e.target.value) })} /></Field>
      <Field label="发布状态" className="status-field"><VisibilitySegment value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} /></Field>
      <Field label="备注" className="remark-field"><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} placeholder="可选备注" /></Field>
    </div>
  );
}

function UploadFloating({ state, onClose }: { state: UploadProgress; onClose: () => void }) {
  if (!state.visible) return null;
  return (
    <div className="upload-float">
      <div className="panel-head">
        <h2>上传队列</h2>
        {state.progress >= 100 && <button className="icon" onClick={onClose} aria-label="关闭上传状态"><X size={16} /></button>}
      </div>
      <strong title={state.fileName}>{state.fileName}</strong>
      <span>{state.stage} · 剩余 {state.remaining} 个文件</span>
      <div className="progress"><i style={{ width: `${state.progress}%` }} /></div>
    </div>
  );
}

function PublishFile({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [form, setForm] = useState({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public' as Visibility, expire_at: '', max_views: 0, format: 'markdown' });
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<Content[]>([]);
  const [progress, setProgress] = useState<UploadProgress>({ visible: false, stage: '', fileName: '', remaining: 0, progress: 0 });
  const load = () => api<{ items: Content[] }>('/api/contents?type=file').then((r) => setRecent(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);
  async function upload() {
    if (!files.length) return toast('请选择至少一个文件', 'error');
    setBusy(true);
    setProgress({ visible: true, stage: '准备提交', fileName: files[0].name, remaining: files.length, progress: 12 });
    const fd = new FormData();
    files.forEach((f) => fd.append('file', f));
    Object.entries({ ...form, expire_at: form.expire_at || '' }).forEach(([k, v]) => fd.append(k, String(v)));
    try {
      setProgress({ visible: true, stage: '上传到 Worker API', fileName: files[0].name, remaining: files.length, progress: 42 });
      const res = await api<{ url: string }>('/api/contents/upload', { method: 'POST', body: fd });
      setProgress({ visible: true, stage: '写入 R2 并进入 Queue', fileName: files[files.length - 1].name, remaining: 0, progress: 78 });
      window.setTimeout(() => setProgress({ visible: true, stage: '队列已确认，等待后台激活', fileName: files[files.length - 1].name, remaining: 0, progress: 100 }), 450);
      toast(`上传已进入队列：${res.url}`);
      setFiles([]);
      setForm({ title: '', content: '', remark: '', slug: '', password: '', visibility: 'public', expire_at: '', max_views: 0, format: 'markdown' });
      load();
    } catch (err) {
      setProgress((prev) => ({ ...prev, stage: '上传失败', progress: 100 }));
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack">
      <section className="panel file-panel">
        <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); setFiles([...files, ...Array.from(e.dataTransfer.files)]); }}>
          <Upload size={32} />
          <strong>拖拽文件到这里</strong>
          <label className="primary as-label">选择文件<input type="file" multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files || [])])} /></label>
        </div>
        {!!files.length && <div className="file-list">{files.map((f, i) => <div key={`${f.name}-${i}`}><span>{f.name}</span><small>{fmtBytes(f.size)}</small><button className="icon" onClick={() => setFiles(files.filter((_, idx) => idx !== i))}><X size={16} /></button></div>)}</div>}
        <OptionsGrid form={form} setForm={setForm} />
        <Field label="可选文字内容"><textarea className="short" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="填写后会创建文字 + 附件" /></Field>
        <button className="primary" onClick={upload} disabled={busy}><Upload size={16} /> 开始上传</button>
      </section>
      <ContentTable title="最近上传 / 我的文件" items={recent} toast={toast} refresh={load} compact />
      <UploadFloating state={progress} onClose={() => setProgress({ visible: false, stage: '', fileName: '', remaining: 0, progress: 0 })} />
    </div>
  );
}

function ContentTable({ title, items, toast, refresh, admin = false, compact = false }: { title: string; items: Content[]; toast: (s: string, k?: Toast['kind']) => void; refresh: () => void; admin?: boolean; compact?: boolean }) {
  const [editing, setEditing] = useState<Content | null>(null);
  async function act(item: Content, action: string, method = 'POST') {
    if ((action === 'delete' || action === 'permanent') && !confirm(action === 'permanent' ? '永久删除会清理 D1 和 R2 对象，确认继续？' : '确认软删除？')) return;
    try {
      const base = admin ? '/api/admin/contents' : '/api/contents';
      await api(`${base}/${item.id}/${action}`, { method });
      toast('操作完成');
      refresh();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function copyQr(item: Content) {
    const dataUrl = await QRCode.toDataURL(publicLink(item.slug), { margin: 1, width: 260 });
    await navigator.clipboard.writeText(dataUrl);
    toast('二维码 Data URL 已复制');
  }
  return (
    <section className="panel table-panel">
      <div className="panel-head"><h2>{title}</h2></div>
      <div className="table-scroll">
        <table className={compact ? 'compact' : ''}>
          <thead><tr><th>标题</th><th>slug / 链接</th><th>类型</th><th>可见性</th><th>状态</th><th>文件大小</th><th>访问</th><th>最大</th><th>创建时间</th><th>过期时间</th><th>操作</th></tr></thead>
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
                <td>{item.max_views || '无限'}</td>
                <td>{fmtDate(item.created_at)}</td>
                <td>{fmtDate(item.expire_at)}</td>
                <td>
                  <div className="actions">
                    <a className="icon" href={`/s/${item.slug}${admin ? '?admin_preview=1' : ''}`} target="_blank" rel="noreferrer" aria-label="打开链接" title="打开链接"><LinkIcon size={16} /></a>
                    <button className="icon" onClick={() => navigator.clipboard.writeText(publicLink(item.slug)).then(() => toast('链接已复制'))} aria-label="复制链接" title="复制链接"><Clipboard size={16} /></button>
                    <button className="icon" onClick={() => copyQr(item)} aria-label="复制二维码" title="复制二维码"><QrCode size={16} /></button>
                    <button className="icon" onClick={() => setEditing(item)} aria-label="编辑" title="编辑"><Pencil size={16} /></button>
                    {item.status !== 'expired' && <button className="icon" onClick={() => act(item, 'expire')} aria-label="使过期" title="使过期"><RefreshCw size={16} /></button>}
                    {item.status !== 'active' && <button className="icon" onClick={() => act(item, 'restore')} aria-label="恢复" title="恢复"><RotateCw size={16} /></button>}
                    {item.status !== 'deleted' && <button className="icon danger" onClick={() => act(item, 'delete')} aria-label="删除" title="删除"><Trash2 size={16} /></button>}
                    {admin && <button className="icon danger" onClick={() => act(item, 'permanent', 'DELETE')} aria-label="永久删除" title="永久删除"><X size={16} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td colSpan={11} className="empty">暂无数据</td></tr>}
          </tbody>
        </table>
      </div>
      {editing && <EditContent item={editing} admin={admin} close={() => setEditing(null)} done={() => { setEditing(null); refresh(); }} toast={toast} />}
    </section>
  );
}

function EditContent({ item, admin, close, done, toast }: { item: Content; admin: boolean; close: () => void; done: () => void; toast: (s: string, k?: Toast['kind']) => void }) {
  const [form, setForm] = useState({ title: item.title, remark: item.remark || '', visibility: item.visibility, expire_at: item.expire_at || '', max_views: item.max_views, text_content: item.text_content || '', format: item.format });
  async function save() {
    try {
      await api(`${admin ? '/api/admin/contents' : '/api/contents'}/${item.id}`, { method: 'PATCH', body: JSON.stringify(form) });
      toast('已保存');
      done();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="modal"><div className="dialog">
      <div className="panel-head"><h2>{admin ? 'Admin 修改内容' : '编辑内容'}</h2><button className="icon" onClick={close}><X /></button></div>
      {!admin && <Field label="标题"><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>}
      <Field label="发布状态"><VisibilitySegment value={form.visibility} onChange={(visibility) => setForm({ ...form, visibility })} /></Field>
      <Field label="过期时间"><input type="datetime-local" value={form.expire_at || ''} onChange={(e) => setForm({ ...form, expire_at: e.target.value })} /></Field>
      <Field label="最大打开次数"><input type="number" min="0" value={form.max_views} onChange={(e) => setForm({ ...form, max_views: Number(e.target.value) })} /></Field>
      {!admin && item.type !== 'file' && <Field label="文本内容"><textarea className="short" value={form.text_content} onChange={(e) => setForm({ ...form, text_content: e.target.value })} /></Field>}
      {!admin && <Field label="备注"><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></Field>}
      <div className="right"><button className="soft" onClick={close}>取消</button><button className="primary" onClick={save}>保存</button></div>
    </div></div>
  );
}

function MyContents({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [items, setItems] = useState<Content[]>([]);
  const [filter, setFilter] = useState({ q: '', type: '', status: '' });
  const load = () => {
    const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    api<{ items: Content[] }>(`/api/contents?${qs}`).then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  };
  useEffect(load, [filter.type, filter.status]);
  return (
    <div className="stack no-page-x">
      <section className="panel filters">
        <input placeholder="搜索标题 / slug / 备注" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && load()} />
        <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}><option value="">全部类型</option><option>text</option><option>file</option><option>mixed</option></select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}><option value="">全部状态</option><option>active</option><option>processing</option><option>expired</option><option>deleted</option></select>
        <button className="soft" onClick={load}>查询</button>
      </section>
      <ContentTable title="我的内容" items={items} toast={toast} refresh={load} />
    </div>
  );
}

function ApiKeys({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState({ remark: '', expire_at: '' });
  const [newKey, setNewKey] = useState('');
  const load = () => api<{ items: any[] }>('/api/api-keys').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);
  async function create() {
    try {
      const res = await api<{ key: string }>('/api/api-keys', { method: 'POST', body: JSON.stringify({ ...form, expire_at: form.expire_at || null }) });
      setNewKey(res.key);
      toast('API Key 已创建，完整值仅显示一次');
      setForm({ remark: '', expire_at: '' });
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function mutate(id: string, action: 'rotate' | 'revoke') {
    if (action === 'revoke' && !confirm('确认吊销这个 API Key？')) return;
    try {
      const res = await api<any>(`/api/api-keys/${id}/${action}`, { method: 'POST' });
      if (res.key) setNewKey(res.key);
      toast(action === 'rotate' ? '已旋转，新 key 仅显示一次' : '已吊销');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="stack">
      <section className="panel">
        <div className="options-grid key-options">
          <Field label="备注"><input value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></Field>
          <Field label="过期日期"><input type="datetime-local" value={form.expire_at} onChange={(e) => setForm({ ...form, expire_at: e.target.value })} /></Field>
        </div>
        <button className="primary" onClick={create}><KeyRound size={16} /> 创建 API Key</button>
        {newKey && <div className="one-time"><strong>完整 API Key（仅显示一次）</strong><code>{newKey}</code><button className="soft" onClick={() => navigator.clipboard.writeText(newKey).then(() => toast('已复制完整 Key'))}>复制</button></div>}
      </section>
      <section className="panel table-panel">
        <div className="table-scroll"><table><thead><tr><th>备注</th><th>Key</th><th>状态</th><th>过期</th><th>最后使用</th><th>调用次数</th><th>操作</th></tr></thead><tbody>
          {items.map((k) => <tr key={k.id}><td>{k.remark || '-'}</td><td><code>{k.key_prefix}...{k.key_suffix}</code></td><td><Badge text={k.status} danger={k.status !== 'active'} /></td><td>{fmtDate(k.expire_at)}</td><td>{fmtDate(k.last_used_at)}</td><td>{k.usage_count}</td><td><div className="actions"><button className="icon" onClick={() => mutate(k.id, 'rotate')}><RotateCw size={16} /></button><button className="icon danger" onClick={() => mutate(k.id, 'revoke')}><Trash2 size={16} /></button></div></td></tr>)}
          {!items.length && <tr><td colSpan={7} className="empty">暂无 API Key</td></tr>}
        </tbody></table></div>
      </section>
    </div>
  );
}

function UserSettings({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [form, setForm] = useState<any>({ default_visibility: 'public', default_expire_days: 0, default_max_views: 0, default_format: 'markdown', default_endpoint: BASE_URL, default_slug_mode: 'random' });
  useEffect(() => { api<{ item: any }>('/api/settings/cli').then((r) => r.item && setForm(r.item)).catch((e) => toast(e.message, 'error')); }, []);
  async function save() {
    try {
      await api('/api/settings/cli', { method: 'PATCH', body: JSON.stringify(form) });
      toast('用户设置已保存');
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
        <Field label="默认发布状态" className="status-field"><VisibilitySegment value={form.default_visibility} onChange={(default_visibility) => setForm({ ...form, default_visibility })} /></Field>
        <Field label="默认过期天数"><input type="number" min="0" value={form.default_expire_days} onChange={(e) => setForm({ ...form, default_expire_days: Number(e.target.value) })} /></Field>
        <Field label="默认最大打开次数"><input type="number" min="0" value={form.default_max_views} onChange={(e) => setForm({ ...form, default_max_views: Number(e.target.value) })} /></Field>
        <Field label="默认 Markdown"><select value={form.default_format} onChange={(e) => setForm({ ...form, default_format: e.target.value })}><option value="markdown">markdown</option><option value="plain">plain</option></select></Field>
        <Field label="默认 endpoint"><input readOnly value={form.default_endpoint || BASE_URL} /></Field>
        <Field label="默认 slug 生成"><select value={form.default_slug_mode} onChange={(e) => setForm({ ...form, default_slug_mode: e.target.value })}><option value="random">random</option><option value="custom">custom</option></select></Field>
      </div>
      <pre className="code">{example}</pre>
      <button className="primary" onClick={save}>保存设置</button>
    </section>
  );
}

function AdminPanel({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [tab, setTab] = useState('dashboard');
  const tabs = [['dashboard', 'Dashboard'], ['contents', '内容管理'], ['users', '用户统计'], ['logs', '访问日志'], ['keys', 'API Key 审计'], ['settings', '系统设置']];
  return (
    <div className="stack">
      <div className="tabs">{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'dashboard' && <AdminDashboard toast={toast} />}
      {tab === 'contents' && <AdminContents toast={toast} />}
      {tab === 'users' && <ExpandableAdminTable endpoint="/api/admin/users" title="用户统计" kind="users" toast={toast} />}
      {tab === 'logs' && <ExpandableAdminTable endpoint="/api/admin/access-logs" title="访问日志" kind="logs" toast={toast} />}
      {tab === 'keys' && <ExpandableAdminTable endpoint="/api/admin/api-keys" title="API Key 审计" kind="keys" toast={toast} />}
      {tab === 'settings' && <AdminSettings toast={toast} />}
    </div>
  );
}

function AdminDashboard({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api('/api/admin/dashboard').then(setData).catch((e) => toast(e.message, 'error')); }, []);
  if (!data) return <section className="panel">加载中...</section>;
  const s = data.summary || {};
  const cards = [
    ['总内容数', s.total || 0],
    ['文本数量', s.text_count || 0],
    ['文件数量', s.file_count || 0],
    ['混合数量', s.mixed_count || 0],
    ['R2 总占用', fmtBytes(s.r2_bytes || 0)],
    ['今日访问量', s.today_views || 0],
    ['今日下载量', s.today_downloads || 0],
    ['已过期内容', s.expired_count || 0],
    ['已删除内容', s.deleted_count || 0]
  ];
  return (
    <div className="stack">
      <div className="stats">{cards.map(([label, value]) => <div className="stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="dash-grid">
        <Chart title="用户发布数量排行" rows={data.topUsers.map((r: any) => ({ label: r.username, value: r.count }))} />
        <Chart title="内容类型分布" rows={data.typeDist} />
        <Chart title="发布状态分布" rows={data.statusDist} />
        <Chart title="最近 7 天创建趋势" rows={data.trend.map((r: any) => ({ label: r.day?.slice(5), value: r.value }))} />
      </div>
    </div>
  );
}

function Chart({ title, rows }: { title: string; rows: any[] }) {
  const max = Math.max(1, ...rows.map((r) => Number(r.value || 0)));
  return <section className="panel chart"><h2>{title}</h2>{rows.length ? rows.map((r) => <div className="bar" key={r.label}><span>{r.label}</span><div><i style={{ width: `${(Number(r.value || 0) / max) * 100}%` }} /></div><b>{r.value}</b></div>) : <p className="empty">暂无数据</p>}</section>;
}

function AdminContents({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [items, setItems] = useState<Content[]>([]);
  const load = () => api<{ items: Content[] }>('/api/admin/contents').then((r) => setItems(r.items)).catch((e) => toast(e.message, 'error'));
  useEffect(() => { void load(); }, []);
  return <ContentTable title="Admin 内容管理" items={items} toast={toast} refresh={load} admin />;
}

function adminColumns(kind: string) {
  if (kind === 'users') return ['username', 'total_count', 'text_count', 'file_count', 'last_publish_at', 'role', 'total_file_size'];
  if (kind === 'logs') return ['created_at', 'action', 'slug', 'username', 'ip'];
  return ['owner_username', 'remark', 'key_prefix', 'status', 'last_used_at', 'usage_count'];
}

function labelOf(key: string) {
  const map: Record<string, string> = {
    username: '用户',
    owner_username: '用户',
    total_count: '内容数',
    text_count: '文本',
    file_count: '文件',
    last_publish_at: '最近发布',
    role: '身份',
    total_file_size: '附件占用',
    created_at: '时间',
    action: '动作',
    slug: 'slug',
    ip: 'IP',
    remark: '备注',
    key_prefix: 'Key',
    status: '状态',
    last_used_at: '最后使用',
    usage_count: '调用'
  };
  return map[key] || key;
}

function formatCell(key: string, value: any) {
  if (key.includes('size')) return fmtBytes(Number(value || 0));
  if (key.includes('_at') || key === 'created_at') return fmtDate(value);
  return String(value ?? '-');
}

function ExpandableAdminTable({ endpoint, title, kind, toast }: { endpoint: string; title: string; kind: 'users' | 'logs' | 'keys'; toast: (s: string, k?: Toast['kind']) => void }) {
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
        <div className="searchbox"><Search size={16} /><input placeholder={kind === 'logs' ? '搜索日志' : '搜索用户'} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="active">active</option>
          <option value="expired">expired</option>
          <option value="revoked">revoked</option>
        </select>
        <button className="soft" onClick={load}><RefreshCw size={16} /> 刷新</button>
        <button className="soft" onClick={exportRows}><Download size={16} /> 导出</button>
      </div>
      <div className="admin-table">
        <div className={`admin-row admin-head ${showAction ? '' : 'no-action'}`}>
          <span />
          {columns.map((key) => <strong key={key}>{labelOf(key)}</strong>)}
          {showAction && <strong>操作</strong>}
        </div>
        {filtered.map((row, index) => (
          <div className="admin-row-wrap" key={row.id || row.username || index}>
            <div className={`admin-row ${showAction ? '' : 'no-action'}`}>
              <button className="expand-btn" onClick={() => setExpanded({ ...expanded, [index]: !expanded[index] })} aria-label="展开详情">
                {expanded[index] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {columns.map((key) => <span key={key}>{key === 'status' ? <Badge text={formatCell(key, row[key])} danger={row[key] !== 'active'} /> : formatCell(key, row[key])}</span>)}
              {showAction && <button className="soft compact-btn" onClick={() => setExpanded({ ...expanded, [index]: !expanded[index] })} title="展开/收起详情">操作 ...</button>}
            </div>
            {expanded[index] && (
              <div className="admin-detail">
                {Object.entries(row).map(([key, value]) => <div key={key}><span>{labelOf(key)}</span><strong>{formatCell(key, value)}</strong></div>)}
              </div>
            )}
          </div>
        ))}
        {!filtered.length && <div className="empty">暂无数据</div>}
      </div>
    </section>
  );
}

function AdminSettings({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const [item, setItem] = useState<any>(null);
  const [bg, setBg] = useState<any>(null);
  const [file, setFile] = useState<File | null>(null);
  const [opacity, setOpacity] = useState(0.32);
  useEffect(() => { api<{ item: any }>('/api/admin/settings').then((r) => setItem(r.item)).catch((e) => toast(e.message, 'error')); }, []);
  const loadBg = () => api<{ item: any }>('/api/admin/background').then((r) => { setBg(r.item); setOpacity(Number(r.item?.opacity ?? 0.32)); }).catch((e) => toast(e.message, 'error'));
  useEffect(() => { loadBg(); }, []);
  async function uploadBg() {
    if (!file) return toast('请选择背景图片', 'error');
    const fd = new FormData();
    fd.append('file', file);
    fd.append('opacity', String(opacity));
    try {
      const res = await api<{ item: any }>('/api/admin/background', { method: 'POST', body: fd });
      setBg(res.item);
      setFile(null);
      toast('背景图已上传');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function saveOpacity(next = opacity) {
    try {
      const res = await api<{ item: any }>('/api/admin/background', { method: 'PATCH', body: JSON.stringify({ opacity: next }) });
      setBg(res.item);
      toast('透明度已保存');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  async function clearBg() {
    if (!confirm('确认清除落地页背景图？')) return;
    try {
      await api('/api/admin/background', { method: 'DELETE' });
      setBg(null);
      toast('背景图已清除');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
  return (
    <div className="stack">
      <section className="panel"><h2>系统设置</h2>{item ? <div className="settings-grid">{Object.entries(item).map(([k, v]) => <div key={k}><span>{k}</span><strong>{String(v)}</strong></div>)}</div> : '加载中...'}</section>
      <section className="panel background-admin">
        <div className="panel-head"><h2>落地页背景</h2></div>
        <div className="background-grid">
          <div className="background-preview" style={{ backgroundImage: bg?.url ? `url(${bg.url})` : undefined }}>
            {!bg?.url && <span>暂无背景图</span>}
          </div>
          <div className="background-controls">
            <Field label="替换背景图片"><input type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
            <Field label={`透明度 ${Math.round(opacity * 100)}%`}><input type="range" min="0" max="1" step="0.01" value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} onMouseUp={() => saveOpacity()} onTouchEnd={() => saveOpacity()} /></Field>
            <div className="right wrap-actions">
              <button className="primary roomy-btn" onClick={uploadBg}><Upload size={16} /> 上传/替换</button>
              <button className="soft roomy-btn" onClick={() => saveOpacity()} disabled={!bg}><RefreshCw size={16} /> 保存透明度</button>
              <button className="soft danger roomy-btn" onClick={clearBg} disabled={!bg}><Trash2 size={16} /> 清除</button>
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

function attachmentUrl(attachmentId: string, mode: 'preview' | 'download' | 'preview-info', password: string, adminPreview = false, includeToken = true) {
  const qs = new URLSearchParams();
  if (password) qs.set('password', password);
  if (adminPreview) qs.set('admin_preview', '1');
  if (includeToken && token()) qs.set('token', token());
  const suffix = qs.toString() ? `?${qs}` : '';
  return `/api/attachments/${attachmentId}/${mode}${suffix}`;
}

function clientPreviewKind(attachment: Attachment) {
  const type = attachment.content_type || '';
  const ext = attachment.filename.split('.').pop()?.toLowerCase() || '';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type.startsWith('text/') || ['txt', 'md', 'csv', 'json', 'log', 'xml', 'html', 'css', 'js', 'ts'].includes(ext)) return 'text';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'office';
  return 'download';
}

function attachmentPreviewInfo(attachment: Attachment, password: string, adminPreview: boolean): PreviewInfo {
  const kind = clientPreviewKind(attachment);
  const previewUrl = attachmentUrl(attachment.id, 'preview', password, adminPreview);
  return {
    id: attachment.id,
    filename: attachment.filename,
    content_type: attachment.content_type || 'application/octet-stream',
    size: attachment.size,
    kind,
    preview_url: previewUrl,
    download_url: attachmentUrl(attachment.id, 'download', password, adminPreview),
    office_embed_url: kind === 'office' ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(`${location.origin}${attachmentUrl(attachment.id, 'preview', password, adminPreview, false)}`)}` : null
  };
}

function PdfCanvasPreview({ info }: { info: PreviewInfo }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('正在加载 PDF...');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = '';
    setStatus('正在加载 PDF...');
    setError('');
    (async () => {
      const pdf = await pdfjsLib.getDocument({
        url: info.preview_url,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.0.227/standard_fonts/'
      }).promise;
      if (cancelled) {
        await (pdf as any).destroy?.();
        return;
      }
      setStatus(`共 ${pdf.numPages} 页`);
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
        setError(err instanceof Error ? err.message : 'PDF 预览失败');
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
      {error && <a className="primary" href={info.download_url}><Download size={16} /> 下载</a>}
      <div ref={hostRef} className="pdf-pages" />
    </div>
  );
}

function PreviewCanvas({ info }: { info: PreviewInfo }) {
  const src = info.preview_url;
  const download = info.download_url;
  const name = info.filename;
  return (
    <>
      {info.kind === 'image' && <img src={src} alt={name} />}
      {info.kind === 'video' && <video src={src} controls />}
      {info.kind === 'audio' && <audio src={src} controls />}
      {info.kind === 'pdf' && <PdfCanvasPreview info={info} />}
      {info.kind === 'text' && <iframe src={src} title={name} />}
      {info.kind === 'office' && info.office_embed_url && <iframe src={info.office_embed_url} title={name} />}
      {info.kind === 'office' && !info.office_embed_url && <section className="panel narrow"><h1>Office 文件无法在线预览</h1><p>请下载后在本地查看。</p><a className="primary" href={download}><Download size={16} /> 下载</a></section>}
      {info.kind === 'download' && <section className="panel narrow"><h1>此类型暂不支持在线预览</h1><p>请下载后在本地查看。</p><a className="primary" href={download}><Download size={16} /> 下载</a></section>}
    </>
  );
}

function AttachmentPreview({ attachment, password, adminPreview, previewHref }: { attachment: Attachment; password: string; adminPreview: boolean; previewHref?: string }) {
  const type = attachment.content_type || 'application/octet-stream';
  const info = attachmentPreviewInfo(attachment, password, adminPreview);
  const preview = info.preview_url;
  const download = info.download_url;
  const canFrame = type.startsWith('text/');
  const kind = clientPreviewKind(attachment);
  return (
    <div className="attachment-card">
      <div className="attachment-head">
        <FileUp size={18} />
        <strong>{attachment.filename}</strong>
        <span>{fmtBytes(attachment.size)}</span>
        <a className="soft download-btn attachment-download" href={download}><Download size={16} /> 下载</a>
      </div>
      {type.startsWith('image/') && <img className="file-preview image-preview" src={preview} alt={attachment.filename} />}
      {type.startsWith('video/') && <video className="file-preview" controls src={preview} />}
      {type.startsWith('audio/') && <audio className="audio-preview" controls src={preview} />}
      {canFrame && <iframe className="file-preview frame-preview" src={preview} title={attachment.filename} />}
      {!type.startsWith('image/') && !type.startsWith('video/') && !type.startsWith('audio/') && !canFrame && kind === 'download' && (
        <div className="preview-actions">
          <p className="muted">此文件类型可下载后查看。</p>
        </div>
      )}
    </div>
  );
}

function FilePreviewPage() {
  const attachmentId = location.pathname.split('/preview/')[1]?.split('/')[0] || '';
  const qs = new URLSearchParams(location.search);
  const [info, setInfo] = useState<PreviewInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ item: PreviewInfo }>(attachmentUrl(attachmentId, 'preview-info', qs.get('password') || '', qs.get('admin_preview') === '1'))
      .then((res) => setInfo(res.item))
      .catch((err) => setError((err as Error).message));
  }, [attachmentId]);
  if (error) return <div className="preview-page preview-message"><section className="panel narrow"><h1>无法预览</h1><p>{error}</p></section></div>;
  if (!info) return <div className="preview-page preview-message"><section className="panel narrow">正在加载预览...</section></div>;
  const src = info.preview_url;
  const download = info.download_url;
  const name = info.filename;
  return (
    <div className="preview-page">
      <header className="preview-topbar">
        <strong>{name}</strong>
        <span>{fmtBytes(info.size)} / {info.content_type}</span>
        <a className="primary" href={download}><Download size={16} /> 下载</a>
      </header>
      <main className={`preview-main ${info.kind === 'pdf' ? 'pdf-preview-main' : ''}`}>
        {info.kind === 'image' && <img src={src} alt={name} />}
        {info.kind === 'video' && <video src={src} controls />}
        {info.kind === 'audio' && <audio src={src} controls />}
        {info.kind === 'pdf' && <PdfCanvasPreview info={info} />}
        {info.kind === 'text' && <iframe src={src} title={name} />}
        {info.kind === 'office' && info.office_embed_url && <iframe src={info.office_embed_url} title={name} />}
        {info.kind === 'office' && !info.office_embed_url && <section className="panel narrow"><h1>Office 文件无法在线预览</h1><p>请下载后查看。</p><a className="primary" href={download}><Download size={16} /> 下载文件</a></section>}
        {info.kind === 'download' && <section className="panel narrow"><h1>此类型暂不支持在线预览</h1><p>请下载后查看。</p><a className="primary" href={download}><Download size={16} /> 下载文件</a></section>}
      </main>
    </div>
  );
}

function SharePreviewPage({ item, password, adminPreview, toast }: { item: Content; password: string; adminPreview: boolean; toast: (s: string, k?: Toast['kind']) => void }) {
  const attachments = item.attachments || [];
  const routeFile = new URLSearchParams(location.search).get('file') || '';
  const firstTarget = routeFile || (item.text_content ? 'text' : attachments[0]?.id || '');
  const [selected, setSelected] = useState(firstTarget);
  useEffect(() => { setSelected(firstTarget); }, [item.id, firstTarget]);
  const selectedAttachment = attachments.find((a) => a.id === selected) || (!item.text_content ? attachments[0] : undefined);
  const showText = selected === 'text' || (!selectedAttachment && !!item.text_content);
  const info = selectedAttachment ? attachmentPreviewInfo(selectedAttachment, password, adminPreview) : null;
  const backQs = new URLSearchParams();
  if (adminPreview) backQs.set('admin_preview', '1');
  const backUrl = `/s/${item.slug}${backQs.toString() ? `?${backQs}` : ''}`;
  return (
    <div className="preview-page share-preview-page">
      <header className="preview-topbar share-preview-topbar">
        <a className="soft back-link" href={backUrl}>返回</a>
        <div className="preview-title">
          <strong>{showText ? item.title : info?.filename}</strong>
          <span>{item.visibility} / {item.type} / {fmtBytes(info?.size || item.file_size)}</span>
        </div>
        {(attachments.length + (item.text_content ? 1 : 0)) > 1 && (
          <select value={showText ? 'text' : selectedAttachment?.id || ''} onChange={(e) => setSelected(e.target.value)}>
            {item.text_content && <option value="text">文本内容</option>}
            {attachments.map((a) => <option key={a.id} value={a.id}>{a.filename}</option>)}
          </select>
        )}
        {info ? <a className="primary" href={info.download_url}><Download size={16} /> 下载</a> : <button className="soft" onClick={() => navigator.clipboard.writeText(location.href).then(() => toast('链接已复制'))}>复制链接</button>}
      </header>
      <main className={`preview-main ${showText ? 'text-preview-main' : ''} ${info?.kind === 'pdf' ? 'pdf-preview-main' : ''}`}>
        {showText ? (
          <article className="panel preview content-preview" dangerouslySetInnerHTML={{ __html: item.format === 'markdown' ? marked.parse(item.text_content || '') : `<pre>${escapeHtml(item.text_content || '')}</pre>` }} />
        ) : info ? <PreviewCanvas info={info} /> : <section className="panel narrow">没有可预览的内容</section>}
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
      {replyingTo && <div className="reply-target">回复 @{replyingTo.author.username}</div>}
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={mode === 'memo' ? '写下仅自己可见的备忘...' : '写下评论...'} disabled={disabled || busy} />
      <div className="note-compose-actions">
        {mode === 'comment' && (
          <div className="segmented note-visibility">
            <button type="button" className={visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')}>所有人可见</button>
            <button type="button" className={visibility === 'private' ? 'on' : ''} onClick={() => setVisibility('private')}>仅自己可见</button>
          </div>
        )}
        {onCancel && <button type="button" className="soft" onClick={onCancel}>取消</button>}
        <button type="button" className="primary" onClick={submit} disabled={disabled || busy || !body.trim()}>{mode === 'memo' ? '保存备忘' : '发送'}</button>
      </div>
    </div>
  );
}

function NoteItem({ note, mode, onReply, activeReply, clearReply, submit, canManage, onDelete }: { note: ShareNote; mode: 'comment' | 'memo'; onReply: (n: ShareNote) => void; activeReply: string; clearReply: () => void; submit: (body: string, visibility: 'public' | 'private', parentId?: string | null) => Promise<void>; canManage: boolean; onDelete: (noteId: string) => Promise<void> }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <article className="note-item">
      <img className="note-avatar" src={avatarSrc(note.author.avatar_url)} alt={`${note.author.username} 头像`} />
      <div className="note-body">
        <header>
          <strong>{note.author.name || note.author.username}</strong>
          <span>@{note.author.username}</span>
          <span>{fmtDate(note.created_at)}</span>
          <span>IP: {note.ip_region || '未知地区'}</span>
          {note.visibility === 'private' && <b>仅自己可见</b>}
        </header>
        {canManage && (
          <div className="note-menu-wrap">
            <button type="button" className="icon note-menu-btn" aria-label="评论操作" onClick={() => setMenuOpen(true)}><MoreVertical size={16} /></button>
            {menuOpen && (
              <>
                <button type="button" className="note-menu-scrim" aria-label="关闭评论菜单" onClick={() => setMenuOpen(false)} />
                <div className="note-menu">
                  <button type="button" className="danger" onClick={() => { setMenuOpen(false); void onDelete(note.id); }}>删除评论</button>
                </div>
              </>
            )}
          </div>
        )}
        <p>{note.body}</p>
        {mode === 'comment' && <button type="button" className="note-reply" onClick={() => onReply(note)}>回复</button>}
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
  const [notes, setNotes] = useState<ShareNote[]>([]);
  const [mode, setMode] = useState<'comment' | 'memo'>(item.visibility === 'private' ? 'memo' : 'comment');
  const [me, setMe] = useState<User | null>(null);
  const [error, setError] = useState('');
  const [replying, setReplying] = useState('');
  const qs = () => {
    const params = new URLSearchParams();
    if (password) params.set('password', password);
    if (adminPreview) params.set('admin_preview', '1');
    return params.toString() ? `?${params}` : '';
  };
  async function loadNotes() {
    try {
      setError('');
      const res = await api<{ mode: 'comment' | 'memo'; items: ShareNote[] }>(`/api/share/${item.slug}/notes${qs()}`);
      setMode(res.mode);
      setNotes(res.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  useEffect(() => {
    api<{ user: User }>('/api/me').then((r) => setMe(r.user)).catch(() => setMe(null));
  }, []);
  useEffect(() => { void loadNotes(); }, [item.id, password, adminPreview]);
  async function submit(body: string, visibility: 'public' | 'private', parentId?: string | null) {
    if (!token()) {
      login();
      return;
    }
    const res = await api<{ items: ShareNote[] }>(`/api/share/${item.slug}/notes${qs()}`, {
      method: 'POST',
      body: JSON.stringify({ body, visibility, parent_id: parentId || null })
    });
    setNotes(res.items);
    setReplying('');
    toast(mode === 'memo' ? '备忘已保存' : '评论已发送');
  }
  async function deleteNote(noteId: string) {
    if (!confirm('确认删除这条评论？')) return;
    const res = await api<{ items: ShareNote[] }>(`/api/share/${item.slug}/notes/${noteId}${qs()}`, { method: 'DELETE' });
    setNotes(res.items);
    toast(mode === 'memo' ? '备忘已删除' : '评论已删除');
  }
  const canMemo = mode !== 'memo' || me?.username === item.owner_username;
  const canManageNotes = me?.username === item.owner_username;
  return (
    <section className="panel notes-panel">
      <div className="notes-head">
        <div>
          <h2>{mode === 'memo' ? '备忘' : '评论'}</h2>
          <p>{mode === 'memo' ? '仅上传者可见和编辑' : '有权限查看内容的人可以查看公开评论，登录后可评论或回复。'}</p>
        </div>
        <span>{notes.length}</span>
      </div>
      {error && <div className="note-empty">{error}</div>}
      {mode === 'memo' && !canMemo ? (
        <div className="note-empty">备忘仅上传者可见</div>
      ) : (
        <>
          <NoteComposer mode={mode} onSubmit={submit} disabled={mode === 'memo' && !canMemo} />
          <div className="notes-list">
            {notes.map((note) => <NoteItem key={note.id} note={note} mode={mode} onReply={(target) => setReplying(target.id)} activeReply={replying} clearReply={() => setReplying('')} submit={submit} canManage={canManageNotes} onDelete={deleteNote} />)}
            {!notes.length && !error && <div className="note-empty">{mode === 'memo' ? '还没有备忘' : '还没有评论'}</div>}
          </div>
        </>
      )}
    </section>
  );
}

function ContentPreviewPage({ toast }: { toast: (s: string, k?: Toast['kind']) => void }) {
  const { slug, preview } = parseShareRoute();
  const [password, setPassword] = useState('');
  const [item, setItem] = useState<Content | null>(null);
  const [error, setError] = useState('');
  const adminPreview = new URLSearchParams(location.search).get('admin_preview') === '1';
  async function load(pass = password) {
    try {
      setError('');
      const qs = new URLSearchParams();
      if (pass) qs.set('password', pass);
      if (adminPreview) qs.set('admin_preview', '1');
      const res = await api<{ item: Content }>(`/api/share/${slug}?${qs}`);
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
          <h1>无法访问</h1>
          <p>{error}</p>
          {needsPassword ? (
            <div className="password-row">
              <input type="password" placeholder="访问密码" value={password} onChange={(e) => setPassword(e.target.value)} />
              <button className="primary" onClick={() => load(password)}>提交密码</button>
            </div>
          ) : token() ? null : <button className="primary" onClick={login}>使用 auth-center 登录</button>}
        </section>
      </div>
    );
  }
  if (!item) return <div className="share-shell"><section className="panel narrow">正在加载预览...</section></div>;
  if (preview) return <SharePreviewPage item={item} password={password} adminPreview={adminPreview} toast={toast} />;
  const previewQs = new URLSearchParams(location.search);
  if (item.attachments?.[0]) previewQs.set('file', item.attachments[0].id);
  const previewUrl = `/s/${item.slug}/preview${previewQs.toString() ? `?${previewQs}` : ''}`;
  return (
    <div className="share-shell">
      <header className="share-top">
        <div>
          <span className="eyebrow">{item.visibility} / {item.type}</span>
          <h1>{item.title}</h1>
          <p>{fmtDate(item.created_at)} · {item.max_views ? `${item.view_count}/${item.max_views} 次访问` : `${item.view_count} 次访问`}</p>
        </div>
        <div className="share-top-actions">
          {!preview && <a className="primary" href={previewUrl}>打开预览页</a>}
          <button className="soft" onClick={() => navigator.clipboard.writeText(location.href).then(() => toast('链接已复制'))}>复制链接</button>
        </div>
      </header>
      <main className={`share-layout ${preview ? 'preview-mode' : ''}`}>
        <div className="share-main-column">
          {item.text_content && (
            <section className="panel share-text">
              <h2>文本内容</h2>
              <article className="preview content-preview" dangerouslySetInnerHTML={{ __html: item.format === 'markdown' ? marked.parse(item.text_content) : `<pre>${escapeHtml(item.text_content)}</pre>` }} />
            </section>
          )}
          {!!item.attachments?.length && (
            <section className="panel share-files">
              <h2>文件预览</h2>
              {item.attachments.map((a) => {
                const fileQs = new URLSearchParams(location.search);
                fileQs.set('file', a.id);
                return <AttachmentPreview key={a.id} attachment={a} password={password} adminPreview={adminPreview} previewHref={`/s/${item.slug}/preview?${fileQs}`} />;
              })}
            </section>
          )}
        </div>
        <ShareNotesPanel item={item} password={password} adminPreview={adminPreview} toast={toast} />
      </main>
    </div>
  );
}

function LandingPage({ background }: { background: any }) {
  const style = background?.url
    ? ({
        '--landing-bg': `url(${background.url})`,
        '--landing-opacity': String(background.opacity ?? 0.32)
      } as React.CSSProperties)
    : undefined;
  return (
    <div className={`login landing ${background?.url ? 'with-bg' : ''}`} style={style}>
      <section className="landing-hero">
        <div className="landing-copy">
          <span className="eyebrow">Cloudflare Workers / D1 / R2</span>
          <h1>ShareWorker</h1>
          <p>用一个轻量链接发布文本、Markdown 和文件。公开分享、内部访问、私有内容和 API Key 上传都由后端真实权限控制。</p>
          <div className="landing-actions">
            <button className="primary" onClick={login}><UserRound size={18} /> 使用 auth-center 登录</button>
            <a className="soft" href={`${BASE_URL}/api/cli/upload-text`} onClick={(e) => e.preventDefault()}>CLI API Ready</a>
          </div>
        </div>
        <div className="landing-console" aria-label="CLI 示例">
          <div><span /> <span /> <span /></div>
          <pre>{`curl -X POST ${BASE_URL}/api/cli/upload-text
  -H "Authorization: Bearer <API_KEY>"
  -d '{"format":"markdown","visibility":"public"}'`}</pre>
        </div>
        <div className="landing-metrics">
          <div><strong>SSO</strong><span>auth-center 登录</span></div>
          <div><strong>R2</strong><span>附件对象存储</span></div>
          <div><strong>D1</strong><span>统计与权限数据</span></div>
        </div>
      </section>
    </div>
  );
}

function App() {
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
    if (!location.pathname.startsWith('/s/')) {
      api<{ item: { landing_background?: any } }>('/api/public/settings').then((r) => setLandingBackground(r.item?.landing_background || null)).catch(() => {});
      api<{ user: User }>('/api/me').then((r) => setUser(r.user)).catch(() => setUser(null));
    }
  }, []);
  if (location.pathname.startsWith('/preview/')) return <FilePreviewPage />;
  if (location.pathname.startsWith('/s/')) return <><ContentPreviewPage toast={push} /><Toasts items={toasts} /></>;
  if (location.pathname === '/sso-callback') return <div className="public-page"><section className="panel narrow">正在完成 auth-center 登录...</section><Toasts items={toasts} /></div>;
  if (!user) return <><LandingPage background={landingBackground} /><Toasts items={toasts} /></>;
  const titleMap: Record<string, string> = { text: '发布文本', file: '发布文件', mine: '我的内容', keys: 'API Key', settings: '用户设置', admin: 'Admin 面板' };
  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar page={page} setPage={setPage} user={user} open={sidebarOpen} setOpen={setSidebarOpen} collapsed={sidebarCollapsed} setCollapsed={setSidebarCollapsed} />
      {sidebarOpen && <button type="button" className="sidebar-scrim" aria-label="关闭侧栏" onClick={() => setSidebarOpen(false)} />}
      <main>
        <Header title={titleMap[page]} onMenu={() => setSidebarOpen(true)} dark={dark} setDark={setDark} user={user} />
        <div className="content">
          {page === 'text' && <PublishText toast={push} />}
          {page === 'file' && <PublishFile toast={push} />}
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

createRoot(document.getElementById('root')!).render(<App />);
