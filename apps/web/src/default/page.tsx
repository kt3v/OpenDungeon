import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionsScreen,
  AuthScreen,
  CampaignScreen,
  SessionScreen,
} from "./screens/game-screens";

type ResourceSchema = {
  id: string;
  label: string;
  source: "characterState" | "worldState";
  stateKey: string;
  type: "number" | "text" | "list" | "boolean";
  defaultValue?: string | number | boolean | unknown[];
  display?: "compact" | "badge";
};

// ── Types ────────────────────────────────────────────────────────────────────

type SessionCharacter = {
  name: string;
  className: string;
  level: number;
  hp: number;
};

type Session = {
  id: string;
  campaignId: string;
  status: "active" | "ended";
  character: SessionCharacter;
  summary?: string;
  createdAt: string;
};

type SessionEvent = {
  id: string;
  playerId: string;
  actionText: string;
  message: string;
  createdAt: string;
};

type ScreenId = "auth" | "campaign" | "session" | "actions";

const baseUrl = (import.meta.env.NEXT_PUBLIC_GATEWAY_URL as string | undefined)
  ?? (import.meta.env.VITE_GATEWAY_URL as string | undefined)
  ?? "http://localhost:3001";

// ── Component ────────────────────────────────────────────────────────────────

export default function HomePage() {
  // Auth
  const [token, setToken] = useState("");
  const isDev = import.meta.env.VITE_DEV_MODE === "true";
  const [email, setEmail] = useState(isDev ? (import.meta.env.VITE_DEV_EMAIL ?? "") : "");
  const [password, setPassword] = useState(isDev ? (import.meta.env.VITE_DEV_PASSWORD ?? "") : "");
  const [language, setLanguage] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Campaign
  const [campaigns, setCampaigns] = useState<Array<{ id: string; title: string }>>([]);
  const [discoverableCampaigns, setDiscoverableCampaigns] = useState<Array<{ id: string; title: string; membersCount: number }>>([]);
  const [selectedCampaignId, setSelectedCampaignIdRaw] = useState("");
  const [newCampaignTitle, setNewCampaignTitle] = useState("My Campaign");

  // Session (= character)
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionIdRaw] = useState("");
  const [availableClasses, setAvailableClasses] = useState<string[]>([]);

  // Actions
  const [actionText, setActionText] = useState("look around");
  const [suggestedActions, setSuggestedActions] = useState<Array<{ id: string; label: string; prompt: string }>>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [sessionSummary, setSessionSummary] = useState("");
  const [isActionPending, setIsActionPending] = useState(false);
  const [resourceSchemas, setResourceSchemas] = useState<ResourceSchema[]>([]);
  const [characterState, setCharacterState] = useState<Record<string, unknown>>({});
  const [worldState, setWorldState] = useState<Record<string, unknown>>({});

  // Navigation
  const [activeScreen, setActiveScreen] = useState<ScreenId>("auth");
  const [bootstrapped, setBootstrapped] = useState(false);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const authHeaders = useMemo(() => ({ authorization: `Bearer ${token}` }), [token]);
  const authJsonHeaders = useMemo(
    () => ({ ...authHeaders, "content-type": "application/json" }),
    [authHeaders]
  );

  const request = async (path: string, options: RequestInit = {}): Promise<any> => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      cache: "no-store",
    });
    const raw = await response.text();
    let payload: any = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { message: raw };
      }
    }
    if (!response.ok) {
      throw new Error(payload?.error ?? payload?.message ?? `Request failed: ${response.status}`);
    }
    return payload;
  };

  // ── Auth ─────────────────────────────────────────────────────────────────

  const handleLogin = async (): Promise<void> => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const data = await request("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, language }),
      });
      setToken(data.token);
      await loadCampaignsWithToken(data.token);
      await loadModuleInfoWithToken(data.token);
      if (activeScreen === "auth") setActiveScreen("campaign");
    } catch (error) {
      setAuthError(String(error).replace("Error: ", ""));
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRegister = async (): Promise<void> => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const data = await request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, displayName: email.split("@")[0], language }),
      });
      setToken(data.token);
      await loadCampaignsWithToken(data.token);
      await loadModuleInfoWithToken(data.token);
      if (activeScreen === "auth") setActiveScreen("campaign");
    } catch (error) {
      setAuthError(String(error).replace("Error: ", ""));
    } finally {
      setAuthLoading(false);
    }
  };

  // ── Module info ───────────────────────────────────────────────────────────

  const loadModuleInfoWithToken = async (tkn: string): Promise<void> => {
    try {
      const data = await request("/module/info", {
        headers: { authorization: `Bearer ${tkn}` },
      });
      setAvailableClasses(data.availableClasses ?? []);
    } catch {
      // silent
    }
  };

  // ── Campaigns ────────────────────────────────────────────────────────────

  const loadCampaignsWithToken = async (tkn: string): Promise<void> => {
    const headers = { authorization: `Bearer ${tkn}` };
    const [joined, discoverable] = await Promise.all([
      request("/campaigns", { headers }),
      request("/campaigns/discover", { headers }).catch(() => ({ campaigns: [] })),
    ]);
    setCampaigns(joined.campaigns ?? []);
    setDiscoverableCampaigns(discoverable.campaigns ?? []);
  };

  const loadCampaigns = async (): Promise<void> => {
    try {
      const [joined, discoverable] = await Promise.all([
        request("/campaigns", { headers: authHeaders }),
        request("/campaigns/discover", { headers: authHeaders }).catch(() => ({ campaigns: [] })),
      ]);
      setCampaigns(joined.campaigns ?? []);
      setDiscoverableCampaigns(discoverable.campaigns ?? []);
    } catch {
      // silent
    }
  };

  const joinDiscoverableCampaign = async (campaignId: string): Promise<void> => {
    try {
      await request(`/campaigns/${campaignId}/join`, {
        method: "POST",
        headers: authHeaders,
      });
      await loadCampaigns();
      await setSelectedCampaignId(campaignId);
    } catch {
      // silent
    }
  };

  const createCampaign = async (): Promise<void> => {
    try {
      const data = await request("/campaigns", {
        method: "POST",
        headers: authJsonHeaders,
        body: JSON.stringify({ title: newCampaignTitle }),
      });
      const id = data.campaign.id;
      await loadCampaigns();
      await setSelectedCampaignId(id);
    } catch {
      // silent
    }
  };

  const deleteCampaign = async (id: string): Promise<void> => {
    try {
      await request(`/campaigns/${id}`, { method: "DELETE", headers: authHeaders });
      if (selectedCampaignId === id) {
        setSelectedCampaignIdRaw("");
        setSelectedSessionIdRaw("");
        setSessions([]);
      }
      await loadCampaigns();
    } catch {
      // silent
    }
  };

  const setSelectedCampaignId = async (id: string) => {
    setSelectedCampaignIdRaw(id);
    setSelectedSessionIdRaw("");
    setSessions([]);
    if (id) {
      await loadSessions(id);
    }
  };

  // ── Sessions (= characters) ───────────────────────────────────────────────

  const loadSessions = async (campaignId = selectedCampaignId): Promise<void> => {
    if (!campaignId) return;
    try {
      const data = await request(`/campaigns/${campaignId}/sessions`, {
        headers: authHeaders,
      });
      setSessions(data.sessions ?? []);
    } catch {
      // silent
    }
  };

  const setSelectedSessionId = (id: string) => {
    setSelectedSessionIdRaw(id);
  };

  const startSession = async (name: string, className: string): Promise<void> => {
    if (!selectedCampaignId) return;
    try {
      const data = await request(`/campaigns/${selectedCampaignId}/sessions`, {
        method: "POST",
        headers: authJsonHeaders,
        body: JSON.stringify({ name, className }),
      });
      const id = data.session.id;
      await loadSessions(selectedCampaignId);
      setSelectedSessionId(id);
    } catch {
      // silent
    }
  };

  const endSession = async (): Promise<void> => {
    if (!selectedSessionId) return;
    try {
      await request(`/sessions/${selectedSessionId}/end`, {
        method: "POST",
        headers: authHeaders,
      });
      await loadSessions();
      setSelectedSessionId("");
    } catch {
      // silent
    }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const loadSessionState = async (sessionId = selectedSessionId): Promise<void> => {
    if (!sessionId) return;
    try {
      const data = await request(`/sessions/${sessionId}/state`, { headers: authHeaders });
      setEvents(data.events ?? []);
      setSessionSummary(typeof data.session?.summary === "string" ? data.session.summary : "");
      setResourceSchemas(data.resourceSchema ?? []);
      setCharacterState(data.characterState ?? {});
      setWorldState(data.worldState ?? {});
    } catch {
      // silent
    }
  };

  const loadSuggestedActions = async (sessionId = selectedSessionId): Promise<void> => {
    if (!sessionId) return;
    try {
      const data = await request(`/sessions/${sessionId}/suggested-actions`, { headers: authHeaders });
      setSuggestedActions(data.suggestedActions ?? []);
    } catch {
      // silent
    }
  };

  const pollActionResult = async (sessionId: string, actionId: string): Promise<{ event?: SessionEvent } | null> => {
    const maxAttempts = 600;
    const pollIntervalMs = 1000;

    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      try {
        const data = await request(`/sessions/${sessionId}/actions/${actionId}`, {
          headers: authHeaders,
        });
        if (data.status === "done") {
          return { event: data.result?.event };
        }
        if (data.status === "failed") {
          throw new Error(data.error ?? "Action failed");
        }
      } catch (err) {
        throw err instanceof Error ? err : new Error("Poll failed");
      }
    }
    throw new Error("POLL_TIMEOUT: Action is taking too long. The response may arrive shortly; try refreshing the page.");
  };

  const submitAction = async (prompt = actionText): Promise<void> => {
    if (isActionPending || !selectedSessionId) return;
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) return;
    setActionText("");
    setIsActionPending(true);
    try {
      const { actionId } = await request(`/sessions/${selectedSessionId}/actions`, {
        method: "POST",
        headers: authJsonHeaders,
        body: JSON.stringify({ actionText: cleanPrompt }),
      });
      const result = await pollActionResult(selectedSessionId, actionId);
      if (result?.event) {
        const newEvent = result.event;
        setEvents(prev => [...prev, newEvent]);
      }
      await loadSessionState(selectedSessionId);
      await loadSuggestedActions(selectedSessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("POLL_TIMEOUT")) {
        setEvents(prev => [...prev, {
          id: `timeout-${Date.now()}`,
          playerId: "system",
          actionText: cleanPrompt,
          message: "⏳ The DM is taking longer than usual. The response will appear when ready.",
          createdAt: new Date().toISOString(),
        }]);
        setTimeout(async () => {
          try {
            const data = await request(`/sessions/${selectedSessionId}/state`, { headers: authHeaders });
            if (data.events?.length > events.length) {
              setEvents(data.events);
              setSessionSummary(typeof data.session?.summary === "string" ? data.session.summary : "");
              setCharacterState(data.characterState ?? {});
              setWorldState(data.worldState ?? {});
              await loadSuggestedActions(selectedSessionId);
            }
          } catch {
            // ignore background refresh errors
          }
        }, 30000);
      }
    } finally {
      setIsActionPending(false);
    }
  };

  const handleContinueToActions = async (): Promise<void> => {
    if (!selectedSessionId) return;
    await loadSessionState(selectedSessionId);
    await loadSuggestedActions(selectedSessionId);
    setActiveScreen("actions");
  };

  // ── Persistence ──────────────────────────────────────────────────────────

  useEffect(() => {
    const savedToken = window.localStorage.getItem("od.token") ?? "";
    const savedEmail = window.localStorage.getItem("od.email") ?? "";
    const savedPassword = window.localStorage.getItem("od.password") ?? "";
    const savedCampaignId = window.localStorage.getItem("od.campaignId") ?? "";
    const savedSessionId = window.localStorage.getItem("od.sessionId") ?? "";

    // Only restore email/password from localStorage in dev mode
    if (isDev) {
      if (savedEmail) setEmail(savedEmail);
      if (savedPassword) setPassword(savedPassword);
    }

    if (savedToken) {
      setToken(savedToken);
      (async () => {
        try {
          await loadCampaignsWithToken(savedToken);
          await loadModuleInfoWithToken(savedToken);
          if (savedCampaignId) {
            setSelectedCampaignIdRaw(savedCampaignId);
            const sesh = await request(`/campaigns/${savedCampaignId}/sessions`, {
              headers: { authorization: `Bearer ${savedToken}` },
            }).catch(() => ({ sessions: [] }));
            setSessions(sesh.sessions ?? []);
          }
          if (savedSessionId) {
            setSelectedSessionIdRaw(savedSessionId);
          }
          setActiveScreen("campaign");
        } catch (err) {
          console.warn("Saved token invalid, clearing:", err);
          setToken("");
          window.localStorage.removeItem("od.token");
          window.localStorage.removeItem("od.campaignId");
          window.localStorage.removeItem("od.sessionId");
          setActiveScreen("auth");
        }
      })();
    }

    setBootstrapped(true);
  }, []);

  const isMounted = useRef(false);
  useEffect(() => {
    if (!bootstrapped) return;
    if (!isMounted.current) {
      isMounted.current = true;
      return;
    }
    window.localStorage.setItem("od.token", token);
    window.localStorage.setItem("od.email", email);
    window.localStorage.setItem("od.password", password);
    window.localStorage.setItem("od.campaignId", selectedCampaignId);
    window.localStorage.setItem("od.sessionId", selectedSessionId);
  }, [bootstrapped, token, email, password, selectedCampaignId, selectedSessionId]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <main className="od-shell">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;700&family=Inter:wght@300;400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg-deep:    #0d0b0f;
          --bg-mid:     #13100f;
          --bg-panel:   #1a1512;
          --bg-card:    #201a14;
          --border:     rgba(180, 140, 70, 0.25);
          --border-hi:  rgba(210, 170, 90, 0.55);
          --gold:       #c9a84c;
          --gold-hi:    #e8c97a;
          --text:       #e8dcc8;
          --text-dim:   #9a8a6e;
          --text-faint: #5a4e3c;
          --accent:     #7c5c2a;
          --accent-hi:  #a87a38;
          --danger:     #8b3030;
          --danger-hi:  #b24040;
          --radius-sm:  8px;
          --radius-md:  14px;
          --radius-lg:  20px;
        }

        html, body {
          height: 100%;
          background: var(--bg-deep);
          color: var(--text);
          font-family: 'Inter', system-ui, sans-serif;
          font-size: 15px;
          line-height: 1.6;
          -webkit-font-smoothing: antialiased;
        }

        body {
          background:
            radial-gradient(ellipse 80% 60% at 10% 0%, rgba(140, 95, 30, 0.12) 0%, transparent 60%),
            radial-gradient(ellipse 60% 50% at 90% 90%, rgba(80, 40, 10, 0.18) 0%, transparent 55%),
            var(--bg-deep);
        }

        .od-shell {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
          padding: 0;
        }

        .od-input {
          width: 100%;
          padding: 12px 16px;
          background: rgba(10, 8, 6, 0.6);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-family: inherit;
          font-size: 15px;
          outline: none;
          transition: border-color 0.2s;
        }
        .od-input:focus { border-color: var(--border-hi); }
        .od-input::placeholder { color: var(--text-faint); }

        .od-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px 20px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: rgba(255,255,255,0.04);
          color: var(--text);
          font-family: inherit;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .od-btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .od-btn:not(:disabled):hover { background: rgba(255,255,255,0.08); border-color: var(--border-hi); }

        .od-btn-primary {
          background: linear-gradient(135deg, #7c5c2a, #5e4320);
          border-color: var(--gold);
          color: var(--gold-hi);
        }
        .od-btn-primary:not(:disabled):hover {
          background: linear-gradient(135deg, #9e7836, #7a5a2e);
          border-color: var(--gold-hi);
          color: #fff7dc;
        }

        .od-btn-ghost {
          background: transparent;
          border-color: var(--border);
          color: var(--text-dim);
        }
        .od-btn-ghost:not(:disabled):hover {
          background: rgba(255,255,255,0.05);
          border-color: var(--border-hi);
          color: var(--text);
        }

        .od-btn-lg { padding: 13px 28px; font-size: 15px; }
        .od-btn-sm { padding: 7px 14px; font-size: 13px; }
        .od-btn-icon { padding: 8px 14px; font-size: 13px; }

        .auth-root {
          min-height: 100vh;
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .auth-card {
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
        }
        .auth-logo { font-size: 48px; filter: drop-shadow(0 0 20px rgba(200, 160, 70, 0.4)); }
        .auth-title {
          font-family: 'Cinzel', 'Palatino Linotype', serif;
          font-size: clamp(2rem, 8vw, 2.8rem);
          font-weight: 700;
          letter-spacing: 0.06em;
          color: var(--gold-hi);
          text-shadow: 0 0 30px rgba(200, 160, 70, 0.3);
          text-align: center;
        }
        .auth-subtitle {
          color: var(--text-dim);
          font-size: 14px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          margin-top: -12px;
        }
        .auth-welcome {
          width: 100%;
          padding: 16px 20px;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          margin-top: 8px;
        }
        .auth-welcome p {
          color: var(--text-dim);
          font-size: 14px;
          line-height: 1.6;
          margin: 0 0 8px 0;
        }
        .auth-welcome p:last-child { margin-bottom: 0; }
        .auth-footer-links {
          width: 100%;
          display: flex;
          justify-content: center;
          gap: 16px;
          padding: 8px 0;
        }
        .footer-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--text-dim);
          font-size: 13px;
          text-decoration: none;
          transition: color 0.15s;
        }
        .footer-link:hover { color: var(--gold); }
        .footer-link-icon { font-size: 14px; }
        .auth-fields { width: 100%; display: flex; flex-direction: column; gap: 12px; }
        .field-group { display: flex; flex-direction: column; gap: 6px; }
        .field-label {
          font-size: 12px;
          font-weight: 500;
          color: var(--text-dim);
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }
        .auth-error {
          width: 100%;
          padding: 10px 14px;
          background: rgba(139, 48, 48, 0.2);
          border: 1px solid rgba(139, 48, 48, 0.5);
          border-radius: var(--radius-sm);
          color: #e88;
          font-size: 13px;
          text-align: center;
        }
        .auth-actions { width: 100%; display: flex; flex-direction: column; gap: 10px; }
        .auth-actions .od-btn { width: 100%; padding: 14px; font-size: 15px; }

        .screen-root {
          width: 100%;
          max-width: 680px;
          margin: 0 auto;
          padding: 32px 24px;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .screen-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .screen-title {
          font-family: 'Cinzel', serif;
          font-size: 1.5rem;
          font-weight: 500;
          color: var(--gold-hi);
          letter-spacing: 0.04em;
        }
        .screen-header-left { display: flex; align-items: center; gap: 12px; }
        .back-btn { color: var(--text-faint); border-color: transparent; padding: 6px 10px; font-size: 13px; }
        .back-btn:hover { color: var(--text-dim) !important; border-color: var(--border) !important; background: rgba(255,255,255,0.04) !important; }
        .actions-topbar { padding-bottom: 4px; }

        .resource-indicators { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 0 8px; }
        .resource-indicator {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 12px;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: 100px;
          font-size: 12px;
          white-space: nowrap;
        }
        .resource-label { color: var(--text-faint); font-weight: 500; text-transform: uppercase; letter-spacing: 0.07em; }
        .resource-value { color: var(--gold-hi); font-weight: 500; }

        .list-area { display: flex; flex-direction: column; gap: 8px; flex: 1; }
        .list-empty { color: var(--text-faint); font-size: 14px; padding: 24px 0; text-align: center; }
        .list-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 18px;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s;
          user-select: none;
        }
        .list-item:hover { border-color: var(--border-hi); background: rgba(255,255,255,0.03); }
        .list-item--selected { border-color: var(--gold); background: rgba(140, 95, 30, 0.12); }
        .list-item-icon { color: var(--gold); font-size: 12px; flex-shrink: 0; width: 14px; }
        .list-item-label { flex: 1; font-weight: 500; color: var(--text); }
        .list-item-id { color: var(--text-faint); font-size: 12px; font-family: monospace; }
        .list-item-col { flex: 1; display: flex; flex-direction: column; gap: 2px; }
        .list-item-meta { font-size: 12px; color: var(--text-dim); }
        .list-item-delete {
          opacity: 0;
          background: transparent;
          border: none;
          color: var(--text-dim);
          cursor: pointer;
          font-size: 13px;
          padding: 4px 6px;
          border-radius: 6px;
          transition: opacity 0.15s, color 0.15s, background 0.15s;
          flex-shrink: 0;
        }
        .list-item:hover .list-item-delete { opacity: 1; }
        .list-item-delete:hover { color: #e88; background: rgba(139,48,48,0.2); }
        .list-item--discoverable { opacity: 0.75; }
        .list-item--discoverable:hover { opacity: 1; border-color: var(--border-hi); }
        .list-section-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); margin: 12px 0 4px; padding: 0 2px; }

        .create-row { display: flex; gap: 10px; align-items: center; animation: slideDown 0.2s ease; }
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .create-row .od-input { flex: 1; }

        .create-character-form {
          display: flex;
          flex-direction: column;
          gap: 14px;
          padding: 20px;
          background: var(--bg-card);
          border: 1px solid var(--border-hi);
          border-radius: var(--radius-md);
          animation: slideDown 0.2s ease;
        }
        .class-chips { display: flex; gap: 8px; flex-wrap: wrap; }
        .class-chip {
          padding: 8px 18px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--border);
          border-radius: 100px;
          color: var(--text-dim);
          font-family: inherit;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s;
        }
        .class-chip:hover { border-color: var(--border-hi); color: var(--text); }
        .class-chip--selected { background: rgba(140, 95, 30, 0.2); border-color: var(--gold); color: var(--gold-hi); }

        .selection-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 20px;
          background: rgba(140, 95, 30, 0.08);
          border: 1px solid var(--border-hi);
          border-radius: var(--radius-md);
          margin-top: auto;
          flex-wrap: wrap;
        }
        .selection-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .selection-name { font-weight: 500; color: var(--text); }
        .selection-chars { font-size: 13px; color: var(--text-dim); }
        .footer-actions { display: flex; gap: 10px; align-items: center; }

        .session-badge {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 4px;
          flex-shrink: 0;
        }
        .session-badge--active { background: rgba(60, 100, 60, 0.3); color: #7fc87f; border: 1px solid rgba(80, 140, 80, 0.4); }

        .actions-root {
          width: 100%;
          max-width: 760px;
          margin: 0 auto;
          padding: 24px 20px 120px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          min-height: 100vh;
        }

        .chronicle-wrap { display: flex; justify-content: center; }
        .chronicle-card {
          width: 100%;
          background: var(--bg-card);
          border: 1px solid var(--border);
          border-radius: var(--radius-lg);
          padding: clamp(20px, 4vw, 32px);
        }
        .chronicle-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--gold);
          margin-bottom: 14px;
        }
        .chronicle-text {
          font-family: 'Palatino Linotype', 'Book Antiqua', Palatino, serif;
          font-size: clamp(1rem, 2.2vw, 1.2rem);
          line-height: 1.75;
          color: var(--text);
          text-shadow: 0 0 20px rgba(200, 160, 70, 0.08);
        }
        .chronicle-summary {
          margin-top: 14px;
          font-size: 13px;
          color: var(--text-dim);
          font-style: italic;
          border-top: 1px solid var(--border);
          padding-top: 12px;
        }

        .history-details {
          background: var(--bg-panel);
          border: 1px solid var(--border);
          border-radius: var(--radius-md);
          overflow: hidden;
        }
        .history-summary { padding: 12px 18px; cursor: pointer; font-size: 13px; color: var(--text-dim); list-style: none; user-select: none; }
        .history-summary::-webkit-details-marker { display: none; }
        .history-summary::before { content: "▸ "; color: var(--gold); }
        details[open] .history-summary::before { content: "▾ "; }
        .history-list {
          max-height: 320px;
          overflow-y: auto;
          padding: 0 18px 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          scrollbar-width: thin;
          scrollbar-color: var(--border) var(--bg-card);
        }
        .history-item { border-top: 1px solid var(--border); padding-top: 10px; }
        .history-action { font-size: 12px; color: var(--gold); font-weight: 500; }
        .history-msg { margin-top: 4px; font-size: 14px; color: var(--text-dim); line-height: 1.5; }

        .markdown-content p { margin: 0 0 0.8em 0; }
        .markdown-content p:last-child { margin-bottom: 0; }
        .markdown-content strong { color: var(--gold-hi); font-weight: 600; }
        .markdown-content em { color: var(--text); font-style: italic; }
        .markdown-content code {
          background: rgba(10, 8, 6, 0.8);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Courier New', monospace;
          font-size: 0.9em;
          color: #d4a868;
          border: 1px solid var(--border);
        }
        .markdown-content pre {
          background: rgba(10, 8, 6, 0.8);
          padding: 12px 16px;
          border-radius: var(--radius-sm);
          overflow-x: auto;
          border: 1px solid var(--border);
          margin: 0.8em 0;
        }
        .markdown-content pre code { background: none; padding: 0; border: none; font-size: 0.85em; color: var(--text-dim); }
        .markdown-content ul, .markdown-content ol { margin: 0.8em 0; padding-left: 1.5em; }
        .markdown-content li { margin: 0.3em 0; color: var(--text-dim); }
        .markdown-content li::marker { color: var(--gold); }
        .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 {
          color: var(--gold-hi);
          margin: 1.2em 0 0.6em;
          font-family: 'Cinzel', serif;
          font-weight: 500;
        }
        .markdown-content h1 { font-size: 1.5em; }
        .markdown-content h2 { font-size: 1.3em; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content h4 { font-size: 1em; }
        .markdown-content blockquote {
          border-left: 3px solid var(--gold);
          padding-left: 1em;
          margin: 0.8em 0;
          color: var(--text-dim);
          font-style: italic;
        }
        .markdown-content hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }

        .suggestions-wrap { display: flex; gap: 8px; flex-wrap: wrap; }
        .suggestion-chip {
          padding: 8px 16px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--border);
          border-radius: 100px;
          color: var(--text-dim);
          font-family: inherit;
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .suggestion-chip:not(:disabled):hover { border-color: var(--gold); color: var(--text); background: rgba(140, 95, 30, 0.1); }
        .suggestion-chip:disabled { opacity: 0.4; cursor: not-allowed; }

        .action-dock {
          position: fixed;
          bottom: 0; left: 0; right: 0;
          z-index: 10;
          padding: 12px 20px max(16px, env(safe-area-inset-bottom));
          background: linear-gradient(180deg, transparent 0%, rgba(13, 11, 15, 0.95) 30%, rgba(13, 11, 15, 1) 100%);
          backdrop-filter: blur(8px);
          border-top: 1px solid var(--border);
        }
        .action-dock-inner { display: flex; gap: 10px; max-width: 760px; margin: 0 auto; }
        .action-input { flex: 1; }

        .footer-links {
          display: flex;
          justify-content: center;
          gap: 16px;
          padding: 20px 0;
          margin-top: auto;
        }

        @media (max-width: 560px) {
          .screen-root { padding: 20px 16px; }
          .selection-footer { flex-direction: column; align-items: stretch; }
          .footer-actions { justify-content: flex-end; }
          .actions-root { padding: 16px 12px 110px; }
        }
      `}</style>

      {activeScreen === "auth" && (
        <AuthScreen
          email={email}
          password={password}
          language={language}
          isLoading={authLoading}
          error={authError}
          setEmail={setEmail}
          setPassword={setPassword}
          setLanguage={setLanguage}
          onLogin={() => void handleLogin()}
          onRegister={() => void handleRegister()}
        />
      )}

      {activeScreen === "campaign" && (
        <CampaignScreen
          campaigns={campaigns}
          discoverableCampaigns={discoverableCampaigns}
          selectedCampaignId={selectedCampaignId}
          newCampaignTitle={newCampaignTitle}
          setNewCampaignTitle={setNewCampaignTitle}
          setSelectedCampaignId={(id) => void setSelectedCampaignId(id)}
          onCreateCampaign={() => void createCampaign()}
          onDeleteCampaign={(id) => void deleteCampaign(id)}
          onJoinDiscoverable={(id) => void joinDiscoverableCampaign(id)}
          onJoin={() => {
            if (selectedCampaignId) {
              void loadSessions(selectedCampaignId).then(() => setActiveScreen("session"));
            }
          }}
          onBack={() => setActiveScreen("auth")}
        />
      )}

      {activeScreen === "session" && (
        <SessionScreen
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          availableClasses={availableClasses}
          setSelectedSessionId={setSelectedSessionId}
          onStartSession={(name, className) => void startSession(name, className)}
          onEndSession={() => void endSession()}
          onContinue={() => void handleContinueToActions()}
          onBack={() => setActiveScreen("campaign")}
        />
      )}

      {activeScreen === "actions" && (
        <ActionsScreen
          actionText={actionText}
          suggestedActions={suggestedActions}
          events={events}
          currentMessage={events.at(-1)?.message ?? ""}
          sessionSummary={sessionSummary}
          isActionPending={isActionPending}
          setActionText={setActionText}
          onSendAction={(prompt) => void submitAction(prompt)}
          onBack={() => setActiveScreen("session")}
          resourceSchemas={resourceSchemas}
          sessionCharacter={sessions.find(s => s.id === selectedSessionId)?.character ?? { name: "", className: "", level: 1, hp: 0 }}
          characterState={characterState}
          worldState={worldState}
        />
      )}
    </main>
  );
}
