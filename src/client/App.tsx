import { useEffect, useRef, useState } from "react";
import { BarChart3, BookOpen, Cloud, FileText, LogOut, Menu, MessageSquare, Plus, Send, ThumbsDown, ThumbsUp, Upload, X } from "lucide-react";

type User = { id: string; email: string };
type Document = { id: string; name: string; size: number; status: string; chunk_count: number; created_at: string };
type Conversation = { id: string; title: string; updated_at: string };
type Source = { documentId: string; name: string; text: string; score: number };
type Message = { id: string; role: "user" | "assistant"; content: string; sources?: Source[] | string; rating?: number };
type View = "chat" | "documents" | "analytics";

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("atlas-token") ?? "");
  const [user, setUser] = useState<User | null>(() => JSON.parse(localStorage.getItem("atlas-user") ?? "null"));
  const [view, setView] = useState<View>("chat");
  const [documents, setDocuments] = useState<Document[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [analytics, setAnalytics] = useState<Record<string, number | null>>({});
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const api = async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`/api${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Request failed");
    return data;
  };

  const refresh = async () => {
    try {
      const [documentRows, conversationRows] = await Promise.all([api<Document[]>("/documents"), api<Conversation[]>("/conversations")]);
      setDocuments(documentRows);
      setConversations(conversationRows);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load workspace"); }
  };

  useEffect(() => { if (token) void refresh(); }, [token]);
  useEffect(() => { if (view === "analytics" && token) api<Record<string, number>>("/analytics").then(setAnalytics).catch(() => undefined); }, [view, token]);

  const authenticate = (nextToken: string, nextUser: User) => {
    localStorage.setItem("atlas-token", nextToken);
    localStorage.setItem("atlas-user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  };

  const logout = () => {
    localStorage.removeItem("atlas-token");
    localStorage.removeItem("atlas-user");
    setToken(""); setUser(null); setMessages([]);
  };

  const openConversation = async (id: string) => {
    setBusy(true); setError("");
    try {
      const rows = await api<Message[]>(`/conversations/${id}/messages`);
      setMessages(rows.map((message) => ({ ...message, sources: typeof message.sources === "string" ? JSON.parse(message.sources) : message.sources })));
      setConversationId(id); setView("chat"); setSidebarOpen(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not load conversation"); }
    finally { setBusy(false); }
  };

  const sendMessage = async () => {
    const text = question.trim();
    if (!text || busy) return;
    setQuestion(""); setError(""); setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: text }]); setBusy(true);
    try {
      const result = await api<{ conversationId: string; message: Message }>("/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, conversationId }),
      });
      setConversationId(result.conversationId); setMessages((current) => [...current, result.message]); void refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The assistant could not respond"); }
    finally { setBusy(false); }
  };

  const upload = async (file?: File) => {
    if (!file) return;
    const form = new FormData(); form.append("file", file); setBusy(true); setError("");
    try { await api("/documents", { method: "POST", body: form }); await refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Upload failed"); }
    finally { setBusy(false); }
  };

  const rate = async (id: string, rating: number) => {
    await api(`/messages/${id}/rating`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating }) });
    setMessages((current) => current.map((message) => message.id === id ? { ...message, rating } : message));
  };

  if (!token || !user) return <Auth onAuthenticated={authenticate} />;

  const navigation = [
    { id: "chat" as const, label: "Assistant", icon: MessageSquare },
    { id: "documents" as const, label: "Documents", icon: BookOpen },
    { id: "analytics" as const, label: "Analytics", icon: BarChart3 },
  ];

  return <div className="shell">
    <aside className={sidebarOpen ? "sidebar open" : "sidebar"}>
      <div className="brand"><span className="brand-mark"><Cloud size={20} /></span><strong>Atlas</strong><button className="icon mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Close menu"><X /></button></div>
      <nav>{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => { setView(id); setSidebarOpen(false); }}><Icon size={18} />{label}</button>)}</nav>
      <div className="history-heading"><span>Recent chats</span><button className="icon" title="New chat" onClick={() => { setConversationId(undefined); setMessages([]); setView("chat"); }}><Plus size={17} /></button></div>
      <div className="history">{conversations.map((item) => <button key={item.id} onClick={() => void openConversation(item.id)}>{item.title}</button>)}</div>
      <div className="account"><div className="avatar">{user.email[0].toUpperCase()}</div><div><strong>{user.email.split("@")[0]}</strong><span>{user.email}</span></div><button className="icon" title="Log out" onClick={logout}><LogOut size={17} /></button></div>
    </aside>
    <main>
      <header><button className="icon menu" onClick={() => setSidebarOpen(true)} aria-label="Open menu"><Menu /></button><div><span>Knowledge workspace</span><strong>{view === "chat" ? "AI Assistant" : view[0].toUpperCase() + view.slice(1)}</strong></div><span className="status"><i /> Cloudflare edge</span></header>
      {error && <div className="error" role="alert">{error}<button className="icon" onClick={() => setError("")}><X size={16} /></button></div>}
      {view === "chat" && <section className="chat-view">
        <div className="messages">
          {messages.length === 0 && <div className="empty-chat"><span className="compass"><Cloud size={28} /></span><h1>Ask your knowledge base</h1><p>Answers are grounded in your indexed documents and returned with source references.</p><div className="suggestions">{["Summarize the main ideas", "Find important deadlines", "What topics appear most often?"].map((text) => <button key={text} onClick={() => setQuestion(text)}>{text}</button>)}</div></div>}
          {messages.map((message) => <article key={message.id} className={`message ${message.role}`}><div className="message-role">{message.role === "assistant" ? <Cloud size={16} /> : user.email[0].toUpperCase()}</div><div className="message-body"><p>{message.content}</p>{message.role === "assistant" && <><div className="source-list">{(message.sources as Source[] | undefined)?.map((source, index) => <span key={`${source.documentId}-${index}`}><FileText size={13} />[{index + 1}] {source.name}</span>)}</div><div className="rating"><span>Helpful?</span><button className={message.rating === 1 ? "selected" : ""} onClick={() => void rate(message.id, 1)} aria-label="Helpful"><ThumbsUp size={15} /></button><button className={message.rating === -1 ? "selected" : ""} onClick={() => void rate(message.id, -1)} aria-label="Not helpful"><ThumbsDown size={15} /></button></div></>}</div></article>)}
          {busy && <div className="thinking"><i /><i /><i /></div>}
        </div>
        <div className="composer"><div><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder="Ask about your documents..." rows={1} /><button onClick={() => void sendMessage()} disabled={!question.trim() || busy} aria-label="Send"><Send size={18} /></button></div><span>Grounded by Vectorize · Generated with Workers AI</span></div>
      </section>}
      {view === "documents" && <section className="content-view"><div className="section-title"><div><h1>Documents</h1><p>Files are stored in R2, then chunked and embedded asynchronously.</p></div><label className="primary"><Upload size={17} /> Upload file<input type="file" accept=".txt,.md,.csv,text/*" onChange={(event) => void upload(event.target.files?.[0])} /></label></div><div className="document-table"><div className="table-head"><span>Name</span><span>Status</span><span>Chunks</span><span>Size</span></div>{documents.length === 0 ? <div className="empty-list"><FileText size={30} /><strong>No documents yet</strong><span>Upload a text, Markdown, or CSV file to begin.</span></div> : documents.map((document) => <div className="table-row" key={document.id}><span><i><FileText size={17} /></i><strong>{document.name}</strong></span><span className={`pill ${document.status}`}>{document.status}</span><span>{document.chunk_count}</span><span>{(document.size / 1024).toFixed(1)} KB</span></div>)}</div></section>}
      {view === "analytics" && <section className="content-view"><div className="section-title"><div><h1>Analytics</h1><p>A compact view of activity stored in D1.</p></div></div><div className="metric-grid">{[["Documents", analytics.documents ?? 0], ["Conversations", analytics.conversations ?? 0], ["AI responses", analytics.responses ?? 0], ["Helpful ratings", analytics.helpful ?? 0]].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="latency-panel"><div><span>Average response latency</span><strong>{analytics.avg_latency ? `${(analytics.avg_latency / 1000).toFixed(1)}s` : "No data"}</strong></div><div className="service-map"><span>Worker</span><i /><span>Vectorize</span><i /><span>AI Gateway</span><i /><span>Workers AI</span></div></div></section>}
    </main>
  </div>;
}

function Auth({ onAuthenticated }: { onAuthenticated: (token: string, user: User) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [turnstileToken, setTurnstileToken] = useState("");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/auth/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, turnstileToken }) });
      const data = await response.json() as { token?: string; user?: User; error?: string };
      if (!response.ok || !data.token || !data.user) throw new Error(data.error ?? "Authentication failed");
      onAuthenticated(data.token, data.user);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Authentication failed"); }
    finally { setBusy(false); }
  };
  return <main className="auth-page"><section className="auth-intro"><div className="brand"><span className="brand-mark"><Cloud size={20} /></span><strong>Atlas</strong></div><div><span className="eyebrow">Cloudflare learning lab</span><h1>One workspace.<br />Your documents.<br /><em>Useful answers.</em></h1><p>A hands-on RAG application running across Cloudflare's developer platform.</p></div><div className="stack">{["Workers", "D1", "R2", "Vectorize", "Workers AI", "Queues", "Durable Objects"].map((item) => <span key={item}>{item}</span>)}</div></section><section className="auth-form"><form onSubmit={(event) => void submit(event)}><span className="eyebrow">{mode === "login" ? "Welcome back" : "Create workspace"}</span><h2>{mode === "login" ? "Sign in to Atlas" : "Start your lab"}</h2><p>{mode === "login" ? "Continue exploring your knowledge base." : "Use at least 10 characters for your password."}</p>{error && <div className="form-error">{error}</div>}<label>Email address<input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label><label>Password<input type="password" required minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" /></label><Turnstile onToken={setTurnstileToken} /><button className="submit" disabled={busy}>{busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}</button><button type="button" className="switch" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); setTurnstileToken(""); }}>{mode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}</button></form></section></main>;
}

function Turnstile({ onToken }: { onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widgetId: string | undefined;
    let cancelled = false;
    const render = async () => {
      const config = await fetch("/api/config").then((response) => response.json()) as { turnstileSiteKey: string };
      if (cancelled || !container.current) return;
      const draw = () => {
        if (!cancelled && container.current && window.turnstile) {
          widgetId = window.turnstile.render(container.current, { sitekey: config.turnstileSiteKey, callback: onToken, "expired-callback": () => onToken("") });
        }
      };
      if (window.turnstile) return draw();
      let script = document.querySelector<HTMLScriptElement>('script[data-atlas-turnstile]');
      if (!script) {
        script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.dataset.atlasTurnstile = "true";
        document.head.appendChild(script);
      }
      script.addEventListener("load", draw, { once: true });
    };
    void render();
    return () => { cancelled = true; if (widgetId && window.turnstile) window.turnstile.remove(widgetId); };
  }, [onToken]);
  return <div className="turnstile" ref={container} />;
}

declare global {
  interface Window {
    turnstile?: {
      render(element: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void }): string;
      remove(widgetId: string): void;
    };
  }
}

export default App;