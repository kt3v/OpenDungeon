import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActionsScreen,
  AuthScreen,
  CampaignScreen,
  SessionScreen,
} from "./screens/game-screens";

type ResolvedIndicator = {
  id: string;
  label: string;
  type: "number" | "text" | "list" | "boolean";
  value: unknown;
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

const baseUrl = (import.meta.env.VITE_GATEWAY_URL as string | undefined)
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
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [resolvedIndicators, setResolvedIndicators] = useState<ResolvedIndicator[]>([]);

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
      setResolvedIndicators(data.resolvedIndicators ?? []);
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
    setServerStatus(null);
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
      if (message === "SERVER_DRAINING") {
        // Server is draining — restore text so player can retry, show a status banner
        setActionText(cleanPrompt);
        setServerStatus("⏸️ The server is preparing for a brief restart. Please wait a moment and try again.");
      } else if (message.includes("POLL_TIMEOUT")) {
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
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg-deep:    #06080e;
          --bg-mid:     #0a0d17;
          --bg-panel:   #0e1220;
          --bg-card:    #111726;
          --border:     #1c2f52;
          --border-hi:  #2a4a90;
          --primary:    #1a56e8;
          --primary-hi: #4080ff;
          --accent:     #0e3dd4;
          --text:       #e4eaf8;
          --text-dim:   #7a8fb0;
          --text-faint: #3d506e;
          --danger:     #cc2020;
          --danger-hi:  #e03030;
          --radius-sm:  6px;
          --radius-md:  10px;
          --radius-lg:  14px;
        }

        html, body, #root {
          width: 100%;
          height: 100%;
          min-height: 100%;
          margin: 0;
          background: var(--bg-deep);
          color: var(--text);
          font-family: 'Inter', system-ui, sans-serif;
          font-size: 15px;
          line-height: 1.6;
          -webkit-font-smoothing: antialiased;
        }

        body {
          background:
            radial-gradient(ellipse 70% 50% at 15% 0%, rgba(26, 86, 232, 0.12) 0%, transparent 55%),
            radial-gradient(ellipse 50% 40% at 85% 95%, rgba(14, 61, 212, 0.15) 0%, transparent 50%),
            var(--bg-deep);
          overflow: hidden;
          overscroll-behavior: none;
        }

        .od-shell {
          width: 100%;
          min-height: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: flex-start;
          padding: 0;
          overflow: hidden;
        }

        .od-input {
          width: 100%;
          padding: 12px 16px;
          background: var(--bg-deep);
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          color: var(--text);
          font-family: inherit;
          font-size: 15px;
          outline: none;
          transition: border-color 0.2s;
        }
        .od-input:focus { border-color: var(--primary); }
        .od-input::placeholder { color: var(--text-faint); }

        .od-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 10px 20px;
          border: 1px solid var(--border);
          border-radius: var(--radius-sm);
          background: rgba(255,255,255,0.03);
          color: var(--text);
          font-family: inherit;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s, border-color 0.15s, color 0.15s;
          white-space: nowrap;
          letter-spacing: 0.01em;
        }
        .od-btn:disabled { opacity: 0.35; cursor: not-allowed; }
        .od-btn:not(:disabled):hover { background: rgba(255,255,255,0.07); border-color: var(--border-hi); }

        .od-btn-primary {
          background: var(--primary);
          border-color: var(--primary);
          color: #ffffff;
          font-weight: 600;
        }
        .od-btn-primary:not(:disabled):hover {
          background: var(--primary-hi);
          border-color: var(--primary-hi);
          color: #ffffff;
        }

        .od-btn-ghost {
          background: transparent;
          border-color: var(--border);
          color: var(--text-dim);
          font-weight: 400;
        }
        .od-btn-ghost:not(:disabled):hover {
          background: rgba(26, 86, 232, 0.08);
          border-color: var(--border-hi);
          color: var(--text);
        }

        .od-btn-lg { padding: 13px 28px; font-size: 15px; }
        .od-btn-sm { padding: 7px 14px; font-size: 13px; }
        .od-btn-icon { padding: 8px 14px; font-size: 13px; }

        /* Auth screen floating topbar */
        .auth-topbar {
          position: absolute;
          top: 0;
          right: 0;
          padding: 16px 24px;
          z-index: 10;
        }
        .auth-topbar-link {
          color: var(--text-faint);
          font-size: 13px;
          font-weight: 500;
          text-decoration: none;
          letter-spacing: 0.03em;
          transition: color 0.15s;
        }
        .auth-topbar-link:hover { color: var(--text); }

        /* Game screen header — glassmorphism strip */
        .app-header {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 0 20px;
          height: 44px;
          background: rgba(6, 8, 14, 0.72);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
          border-bottom: 1px solid var(--border);
          flex-shrink: 0;
          width: 100%;
          position: sticky;
          top: 0;
          z-index: 50;
          min-width: 0;
        }
        .app-header-logo {
          width: 20px;
          height: 20px;
          object-fit: contain;
          flex-shrink: 0;
          opacity: 0.9;
        }
        .app-header-title {
          font-size: 13px;
          font-weight: 700;
          color: var(--text);
          letter-spacing: -0.01em;
        }
        .app-header-tagline {
          color: var(--text-faint);
          font-size: 11px;
          letter-spacing: 0.04em;
        }
        .app-header-link {
          margin-left: auto;
          color: var(--text-faint);
          font-size: 12px;
          font-weight: 500;
          text-decoration: none;
          transition: color 0.15s;
          letter-spacing: 0.03em;
        }
        .app-header-link:hover { color: var(--text); }

        /* Unified Screen Container */
        .screen-container {
          min-height: 100svh;
          max-height: 100svh;
          height: 100svh;
          height: 100vh;
          height: 100dvh;
          width: 100%;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-width: 0;
        }
        .screen-content {
          width: 100%;
          max-width: 680px;
          margin: 0 auto;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
        }

        .auth-root {
          min-height: 100svh;
          height: 100svh;
          height: 100dvh;
          width: 100%;
          display: flex;
          flex-direction: column;
          position: relative;
          overflow-y: auto;
          overflow-x: hidden;
        }
        .auth-card {
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 20px;
          margin: auto;
          padding: 24px;
        }

        /* Auth Brand (vertical on auth screen) */
        .auth-brand {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .auth-brand .auth-logo {
          width: 90px;
          height: 90px;
          object-fit: contain;
          filter: drop-shadow(0 0 24px rgba(26, 86, 232, 0.55));
        }
        .auth-brand .auth-title {
          font-family: 'Inter', system-ui, sans-serif;
          font-size: clamp(2rem, 8vw, 2.8rem);
          font-weight: 700;
          letter-spacing: -0.03em;
          color: #ffffff;
          text-shadow: 0 0 40px rgba(26, 86, 232, 0.5);
          text-align: center;
        }
        .auth-brand .auth-subtitle {
          color: var(--text-dim);
          font-size: 12px;
          letter-spacing: 0.15em;
          text-transform: uppercase;
        }
        .auth-subtitle-row {
          display: flex;
          align-items: center;
          gap: 10px;
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
        .footer-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: var(--text-dim);
          font-size: 13px;
          text-decoration: none;
          transition: color 0.15s;
        }
        .footer-link:hover { color: var(--primary); }
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

        /* Unified screen root - removed negative margin hacks */
        .screen-root {
          width: 100%;
          max-width: 680px;
          margin: 0 auto;
          padding: 24px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow: hidden;
        }
        .screen-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .screen-title {
          font-family: 'Inter', system-ui, sans-serif;
          font-size: 1.5rem;
          font-weight: 700;
          color: var(--text);
          letter-spacing: -0.02em;
        }
        .screen-header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
        .character-header {
          display: flex;
          align-items: baseline;
          gap: 10px;
          min-width: 0;
          flex-wrap: wrap;
        }
        .character-meta {
          font-size: 13px;
          color: var(--text-dim);
          white-space: nowrap;
        }
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

        .list-area {
          display: flex;
          flex-direction: column;
          gap: 8px;
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 4px;
          scrollbar-width: thin;
          scrollbar-color: rgba(64, 128, 255, 0.7) transparent;
        }
        .list-area::-webkit-scrollbar { width: 10px; }
        .list-area::-webkit-scrollbar-track { background: transparent; }
        .list-area::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, rgba(64, 128, 255, 0.9), rgba(26, 86, 232, 0.75));
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
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
          min-width: 0;
        }
        .list-item:hover { border-color: var(--border-hi); background: rgba(255,255,255,0.03); }
        .list-item--selected { border-color: var(--primary); background: rgba(26, 86, 232, 0.14); }
        .list-item-icon { color: var(--primary); font-size: 12px; flex-shrink: 0; width: 14px; }
        .list-item-label { flex: 1; font-weight: 500; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .list-item-id { color: var(--text-faint); font-size: 12px; font-family: monospace; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .list-item-col { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .list-item-meta { font-size: 12px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
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
        .class-chip--selected { background: rgba(26, 86, 232, 0.22); border-color: var(--primary); color: var(--primary-hi); font-weight: 600; }

        .selection-footer, .action-footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 16px 20px;
          background: rgba(26, 86, 232, 0.07);
          border: 1px solid var(--border-hi);
          border-radius: var(--radius-md);
          margin-top: auto;
          flex-wrap: wrap;
        }
        .selection-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .selection-name { font-weight: 500; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .selection-chars { font-size: 13px; color: var(--text-dim); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .footer-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .action-footer { margin-top: 0; }
        .action-footer .action-input {
          flex: 1;
          min-width: 0;
          background: transparent !important;
          border-color: transparent !important;
          box-shadow: none !important;
        }
        .action-footer .action-input:focus,
        .action-footer .action-input:focus-visible,
        .action-footer .action-input:active,
        .action-footer .action-input:hover {
          background: transparent !important;
          border-color: transparent !important;
          box-shadow: none !important;
          outline: none !important;
        }
        .actions-scroll-area {
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow-y: auto;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          gap: 16px;
          scrollbar-width: thin;
          scrollbar-color: rgba(64, 128, 255, 0.7) transparent;
        }
        .actions-scroll-area::-webkit-scrollbar { width: 10px; }
        .actions-scroll-area::-webkit-scrollbar-track { background: transparent; }
        .actions-scroll-area::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, rgba(64, 128, 255, 0.9), rgba(26, 86, 232, 0.75));
          border-radius: 999px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        .actions-scroll-area::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(90, 150, 255, 0.95), rgba(40, 105, 245, 0.85));
          border: 2px solid transparent;
          background-clip: padding-box;
        }

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

        /* Actions screen uses same layout as others */
        .actions-root {
          width: 100%;
          max-width: 680px;
          margin: 0 auto;
          padding: 24px;
          box-sizing: border-box;
          display: flex;
          flex-direction: column;
          gap: 16px;
          flex: 1;
          min-height: 0;
          overflow: hidden;
        }

        .chronicle-wrap { display: flex; justify-content: center; }
        .chronicle-card {
          width: 100%;
          background: transparent;
          border: none;
          padding: 0;
        }
        .story-tabs {
          position: sticky;
          top: 0;
          z-index: 2;
          display: flex;
          gap: 8px;
          padding: 4px;
          width: fit-content;
          border: 1px solid var(--border);
          border-radius: 999px;
          background: rgba(6, 8, 14, 0.75);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .story-tab {
          padding: 6px 14px;
          border: none;
          border-radius: 999px;
          background: transparent;
          color: var(--text-dim);
          font-family: inherit;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          cursor: pointer;
          transition: color 0.15s, background 0.15s;
        }
        .story-tab:hover:not(:disabled) { color: var(--text); }
        .story-tab--active {
          background: rgba(26, 86, 232, 0.22);
          color: var(--primary-hi);
        }
        .story-tab:disabled { opacity: 0.45; cursor: not-allowed; }
        .story-panel { display: flex; flex-direction: column; gap: 16px; }
        .chronicle-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--text-faint);
          margin-bottom: 14px;
        }
        .chronicle-text {
          font-family: 'Inter', system-ui, sans-serif;
          font-size: clamp(1rem, 2.2vw, 1.15rem);
          line-height: 1.8;
          color: var(--text);
        }
        .chronicle-summary {
          margin-top: 14px;
          font-size: 13px;
          color: var(--text-dim);
          font-style: italic;
          border-top: 1px solid var(--border);
          padding-top: 12px;
        }

        .history-list {
          padding: 2px 0 8px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .history-list--tab { min-height: 120px; }
        .history-item { border-top: 1px solid var(--border); padding-top: 10px; }
        .history-action { font-size: 12px; color: var(--primary); font-weight: 500; }
        .history-msg { margin-top: 4px; font-size: 14px; color: var(--text-dim); line-height: 1.5; }
        .history-empty {
          color: var(--text-faint);
          font-size: 14px;
          padding: 8px 0;
        }

        .markdown-content p { margin: 0 0 0.8em 0; }
        .markdown-content p:last-child { margin-bottom: 0; }
        .markdown-content strong { color: var(--primary-hi); font-weight: 600; }
        .markdown-content em { color: var(--text); font-style: italic; }
        .markdown-content code {
          background: var(--bg-panel);
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'Courier New', monospace;
          font-size: 0.9em;
          color: #60a5fa;
          border: 1px solid var(--border);
        }
        .markdown-content pre {
          background: var(--bg-panel);
          padding: 12px 16px;
          border-radius: var(--radius-sm);
          overflow-x: auto;
          border: 1px solid var(--border);
          margin: 0.8em 0;
        }
        .markdown-content pre code { background: none; padding: 0; border: none; font-size: 0.85em; color: var(--text-dim); }
        .markdown-content ul, .markdown-content ol { margin: 0.8em 0; padding-left: 1.5em; }
        .markdown-content li { margin: 0.3em 0; color: var(--text-dim); }
        .markdown-content li::marker { color: var(--primary); }
        .markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 {
          color: var(--primary-hi);
          margin: 1.2em 0 0.6em;
          font-family: 'Inter', system-ui, sans-serif;
          font-weight: 600;
        }
        .markdown-content h1 { font-size: 1.5em; }
        .markdown-content h2 { font-size: 1.3em; }
        .markdown-content h3 { font-size: 1.1em; }
        .markdown-content h4 { font-size: 1em; }
        .markdown-content blockquote {
          border-left: 3px solid var(--primary);
          padding-left: 1em;
          margin: 0.8em 0;
          color: var(--text-dim);
          font-style: italic;
        }
        .markdown-content hr { border: none; border-top: 1px solid var(--border); margin: 1.2em 0; }

        .suggestions-wrap {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-bottom: 8px;
        }
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
        .suggestion-chip:not(:disabled):hover { border-color: var(--primary); color: var(--text); background: rgba(26, 86, 232, 0.12); }
        .suggestion-chip:disabled { opacity: 0.4; cursor: not-allowed; }

        .action-footer {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px 20px;
          background: rgba(26, 86, 232, 0.07);
          border: 1px solid var(--border-hi);
          border-radius: var(--radius-md);
          margin-top: auto;
        }
        .action-footer .action-input { flex: 1; }
        .action-footer .od-btn-primary { flex-shrink: 0; }

        .footer-links {
          display: flex;
          justify-content: center;
          gap: 16px;
          padding: 20px 0;
          margin-top: auto;
        }

        @media (max-width: 560px) {
          .app-header {
            padding-left: 14px;
            padding-right: 14px;
          }
          .app-header-tagline {
            display: none;
          }
          .screen-root { padding: 20px 16px calc(20px + env(safe-area-inset-bottom)); }
          .selection-footer { flex-direction: column; align-items: stretch; }
          .footer-actions { justify-content: flex-end; }
          .actions-root { padding: 16px 12px calc(16px + env(safe-area-inset-bottom)); }
          .character-meta { white-space: normal; }
          .action-footer {
            padding: 14px 16px;
          }
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
          serverStatus={serverStatus}
          setActionText={setActionText}
          onSendAction={(prompt) => void submitAction(prompt)}
          onBack={() => setActiveScreen("session")}
          resolvedIndicators={resolvedIndicators}
          sessionCharacter={sessions.find(s => s.id === selectedSessionId)?.character ?? { name: "", className: "", level: 1, hp: 0 }}
        />
      )}
    </main>
  );
}
