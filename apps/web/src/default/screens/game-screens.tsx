import { FC } from "react";
import ReactMarkdown from "react-markdown";

// ── Types ────────────────────────────────────────────────────────────────────

type ResourceSchema = {
  id: string;
  label: string;
  source: "characterState" | "worldState";
  stateKey: string;
  type: "number" | "text" | "list" | "boolean";
  defaultValue?: string | number | boolean | unknown[];
  display?: "compact" | "badge";
};

type SessionCharacter = {
  name: string;
  className: string;
  level: number;
  hp: number;
};

type Session = {
  id: string;
  status: "active" | "ended";
  character: SessionCharacter;
};

type SessionEvent = {
  id: string;
  playerId: string;
  actionText: string;
  message: string;
  createdAt: string;
};

// ── Shared Header Component ────────────────────────────────────────────────────

export const AppHeader: FC = () => (
  <div className="app-header">
    <img src="/logo.png" alt="OpenDungeon" className="app-header-logo" />
    <span className="app-header-title">OpenDungeon</span>
    <span className="app-header-tagline">AI-Powered RPG Engine</span>
    <a
      href="https://github.com/kt3v/OpenDungeon"
      target="_blank"
      rel="noopener noreferrer"
      className="app-header-link"
    >
      GitHub
    </a>
  </div>
);

// ── Shared Screen Header Component ─────────────────────────────────────────────

export const ScreenHeader: FC<{
  onBack: () => void;
  title?: string;
  children?: React.ReactNode;
}> = ({ onBack, title, children }) => (
  <div className="screen-header">
    <div className="screen-header-left">
      <button className="od-btn od-btn-sm od-btn-ghost back-btn" onClick={onBack}>← Back</button>
      {title ? <h2 className="screen-title">{title}</h2> : children}
    </div>
  </div>
);

// ── Screen Components ──────────────────────────────────────────────────────────

import { useState, useEffect } from "react";

export const AuthScreen: FC<{
  email: string;
  password: string;
  language: string;
  isLoading: boolean;
  error: string;
  setEmail: (v: string) => void;
  setPassword: (v: string) => void;
  setLanguage: (v: string) => void;
  onLogin: () => void;
  onRegister: () => void;
}> = ({
  email,
  password,
  language,
  isLoading,
  error,
  setEmail,
  setPassword,
  setLanguage,
  onLogin,
  onRegister,
}) => (
  <div className="auth-root">
    <div className="auth-card">
      <div className="auth-brand">
        <img src="/logo.png" alt="OpenDungeon" className="auth-logo" />
        <h1 className="auth-title">OpenDungeon</h1>
        <div className="auth-subtitle-row">
          <div className="auth-subtitle">AI-Powered RPG Engine</div>
          <a
            href="https://github.com/kt3v/OpenDungeon"
            target="_blank"
            rel="noopener noreferrer"
            className="auth-topbar-link"
          >
            GitHub
          </a>
        </div>
      </div>

      <div className="auth-welcome">
        <p>Create an account to start, or sign in to continue your journey.</p>
      </div>

      <div className="auth-fields">
        <div className="field-group">
          <label className="field-label">Email</label>
          <input
            className="od-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="hero@od.dev"
            disabled={isLoading}
          />
        </div>
        <div className="field-group">
          <label className="field-label">Password</label>
          <input
            className="od-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={isLoading}
          />
        </div>
        <div className="field-group">
          <label className="field-label">Language (optional)</label>
          <input
            className="od-input"
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="e.g. en, ru, de"
            disabled={isLoading}
          />
        </div>
      </div>

      {error && <div className="auth-error">{error}</div>}

      <div className="auth-actions">
        <button
          className="od-btn od-btn-primary"
          onClick={onLogin}
          disabled={isLoading || !email || !password}
        >
          {isLoading ? "Signing in..." : "Sign In"}
        </button>
        <button
          className="od-btn od-btn-ghost"
          onClick={onRegister}
          disabled={isLoading || !email || !password}
        >
          Create Account
        </button>
      </div>
    </div>
  </div>
);

export const CampaignScreen: FC<{
  campaigns: Array<{ id: string; title: string }>;
  discoverableCampaigns: Array<{ id: string; title: string; membersCount: number }>;
  selectedCampaignId: string;
  newCampaignTitle: string;
  setNewCampaignTitle: (v: string) => void;
  setSelectedCampaignId: (id: string) => void;
  onCreateCampaign: () => void;
  onDeleteCampaign: (id: string) => void;
  onJoinDiscoverable: (id: string) => void;
  onJoin: () => void;
  onBack: () => void;
}> = ({
  campaigns,
  discoverableCampaigns,
  selectedCampaignId,
  newCampaignTitle,
  setNewCampaignTitle,
  setSelectedCampaignId,
  onCreateCampaign,
  onDeleteCampaign,
  onJoinDiscoverable,
  onJoin,
  onBack,
}) => {
  const [showCreate, setShowCreate] = useState(false);

  const handleCreate = () => {
    onCreateCampaign();
    setShowCreate(false);
  };

  return (
  <div className="screen-container">
    <AppHeader />
    <div className="screen-root">
      <ScreenHeader onBack={onBack} title="Campaigns" />

      <div className="list-area">
        {campaigns.length === 0 && discoverableCampaigns.length === 0 && (
          <div className="list-empty">No campaigns yet. Create one to get started.</div>
        )}

        {campaigns.length > 0 && (
          <>
            <div className="list-section-label">Your Campaigns</div>
            {campaigns.map((c) => (
              <div
                key={c.id}
                className={`list-item ${selectedCampaignId === c.id ? "list-item--selected" : ""}`}
                onClick={() => setSelectedCampaignId(c.id)}
              >
                <span className="list-item-icon">◆</span>
                <div className="list-item-col">
                  <span className="list-item-label">{c.title}</span>
                  <span className="list-item-id">{c.id}</span>
                </div>
                <button
                  className="list-item-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCampaign(c.id);
                  }}
                  title="Delete"
                >
                  ×
                </button>
              </div>
            ))}
          </>
        )}

        {discoverableCampaigns.length > 0 && (
          <>
            <div className="list-section-label">Discoverable Campaigns</div>
            {discoverableCampaigns.map((c) => (
              <div
                key={c.id}
                className="list-item list-item--discoverable"
                onClick={() => onJoinDiscoverable(c.id)}
              >
                <span className="list-item-icon">◎</span>
                <div className="list-item-col">
                  <span className="list-item-label">{c.title}</span>
                  <span className="list-item-meta">{c.membersCount} members</span>
                </div>
              </div>
            ))}
          </>
        )}

        {!showCreate ? (
          <button className="od-btn od-btn-ghost" onClick={() => setShowCreate(true)}>
            + Create New Campaign
          </button>
        ) : (
          <div className="create-character-form">
            <div className="field-group">
              <label className="field-label">Campaign Title</label>
              <input
                className="od-input"
                value={newCampaignTitle}
                onChange={(e) => setNewCampaignTitle(e.target.value)}
                placeholder="Enter campaign title"
                autoFocus
              />
            </div>
            <div className="footer-actions" style={{ justifyContent: "flex-end" }}>
              <button className="od-btn od-btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button
                className="od-btn od-btn-primary"
                disabled={!newCampaignTitle.trim()}
                onClick={handleCreate}
              >
                Create
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="selection-footer">
        <div className="selection-info">
          <span className="selection-name">{selectedCampaignId ? campaigns.find((c) => c.id === selectedCampaignId)?.title || "Selected" : "No campaign selected"}</span>
        </div>
        <div className="footer-actions">
          <button
            className="od-btn od-btn-primary"
            disabled={!selectedCampaignId}
            onClick={onJoin}
          >
            Join →
          </button>
        </div>
      </div>
    </div>
  </div>
  );
};

export const SessionScreen: FC<{
  sessions: Session[];
  selectedSessionId: string;
  availableClasses: string[];
  setSelectedSessionId: (id: string) => void;
  onStartSession: (name: string, className: string) => void;
  onEndSession: () => void;
  onContinue: () => void;
  onBack: () => void;
}> = ({
  sessions,
  selectedSessionId,
  availableClasses,
  setSelectedSessionId,
  onStartSession,
  onEndSession,
  onContinue,
  onBack,
}) => {
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [selectedClass, setSelectedClass] = useState(availableClasses[0] || "");

  useEffect(() => {
    if (availableClasses.length > 0 && !selectedClass) {
      setSelectedClass(availableClasses[0]);
    }
  }, [availableClasses, selectedClass]);

  const activeSessions = sessions.filter((s) => s.status === "active");
  const endedSessions = sessions.filter((s) => s.status === "ended");

  return (
    <div className="screen-container">
      <AppHeader />
      <div className="screen-root">
        <ScreenHeader onBack={onBack} title="Characters" />

        <div className="list-area">
          {activeSessions.length === 0 && endedSessions.length === 0 && (
            <div className="list-empty">No characters yet. Create one to begin your adventure.</div>
          )}

          {activeSessions.length > 0 && (
            <>
              <div className="list-section-label">Active Characters</div>
              {activeSessions.map((s) => (
                <div
                  key={s.id}
                  className={`list-item ${selectedSessionId === s.id ? "list-item--selected" : ""}`}
                  onClick={() => setSelectedSessionId(s.id)}
                >
                  <span className="list-item-icon">●</span>
                  <div className="list-item-col">
                    <span className="list-item-label">{s.character.name}</span>
                    <span className="list-item-meta">Level {s.character.level} {s.character.className} • {s.character.hp} HP</span>
                  </div>
                  <span className="session-badge session-badge--active">Active</span>
                </div>
              ))}
            </>
          )}

          {endedSessions.length > 0 && (
            <>
              <div className="list-section-label">Previous Characters</div>
              {endedSessions.map((s) => (
                <div
                  key={s.id}
                  className={`list-item ${selectedSessionId === s.id ? "list-item--selected" : ""}`}
                  onClick={() => setSelectedSessionId(s.id)}
                >
                  <span className="list-item-icon">○</span>
                  <div className="list-item-col">
                    <span className="list-item-label">{s.character.name}</span>
                    <span className="list-item-meta">Level {s.character.level} {s.character.className}</span>
                  </div>
                </div>
              ))}
            </>
          )}

          {!showCreate ? (
            <button className="od-btn od-btn-ghost" onClick={() => setShowCreate(true)}>
              + Create New Character
            </button>
          ) : (
            <div className="create-character-form">
              <div className="field-group">
                <label className="field-label">Name</label>
                <input
                  className="od-input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Enter character name"
                  autoFocus
                />
              </div>

              <div className="field-group">
                <label className="field-label">Class</label>
                <div className="class-chips">
                  {availableClasses.map((cls) => (
                    <button
                      key={cls}
                      className={`class-chip ${selectedClass === cls ? "class-chip--selected" : ""}`}
                      onClick={() => setSelectedClass(cls)}
                    >
                      {cls}
                    </button>
                  ))}
                </div>
              </div>

              <div className="footer-actions" style={{ justifyContent: "flex-end" }}>
                <button className="od-btn od-btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
                <button
                  className="od-btn od-btn-primary"
                  disabled={!newName || !selectedClass}
                  onClick={() => {
                    onStartSession(newName, selectedClass);
                    setShowCreate(false);
                    setNewName("");
                  }}
                >
                  Create
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="selection-footer">
          <div className="selection-info">
            {selectedSessionId ? (
              <>
                <span className="selection-name">{sessions.find((s) => s.id === selectedSessionId)?.character.name}</span>
                {sessions.find((s) => s.id === selectedSessionId)?.status !== "active" && (
                  <span className="selection-chars">Session ended</span>
                )}
              </>
            ) : (
              <span className="selection-name">No character selected</span>
            )}
          </div>
          <div className="footer-actions">
            {selectedSessionId && sessions.find((s) => s.id === selectedSessionId)?.status === "active" && (
              <button className="od-btn od-btn-ghost" onClick={onEndSession}>End Session</button>
            )}
            <button
              className="od-btn od-btn-primary"
              disabled={!selectedSessionId}
              onClick={onContinue}
            >
              Play →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const ActionsScreen: FC<{
  actionText: string;
  suggestedActions: Array<{ id: string; label: string; prompt: string }>;
  events: SessionEvent[];
  currentMessage: string;
  sessionSummary: string;
  isActionPending: boolean;
  serverStatus?: string | null;
  setActionText: (v: string) => void;
  onSendAction: (prompt: string) => void;
  onBack: () => void;
  resourceSchemas: ResourceSchema[];
  sessionCharacter: SessionCharacter;
  characterState: Record<string, unknown>;
  worldState: Record<string, unknown>;
}> = ({
  actionText,
  suggestedActions,
  events,
  currentMessage,
  sessionSummary,
  isActionPending,
  serverStatus,
  setActionText,
  onSendAction,
  onBack,
  resourceSchemas,
  sessionCharacter,
  characterState,
  worldState,
}) => {
  const [activeTab, setActiveTab] = useState<"scene" | "history">("scene");
  const hasHistory = events.length > 1;

  useEffect(() => {
    if (!hasHistory && activeTab === "history") {
      setActiveTab("scene");
    }
  }, [activeTab, hasHistory]);

  const getResourceValue = (schema: ResourceSchema): unknown => {
    const source = schema.source === "characterState" ? characterState : worldState;
    return source[schema.stateKey] ?? schema.defaultValue;
  };

  return (
    <div className="screen-container">
      <AppHeader />
      <div className="actions-root">
        <ScreenHeader onBack={onBack}>
          <div className="character-header">
            <h2 className="screen-title">{sessionCharacter.name}</h2>
            <span className="character-meta">Level {sessionCharacter.level} {sessionCharacter.className}</span>
          </div>
        </ScreenHeader>

        {resourceSchemas.length > 0 && (
          <div className="resource-indicators">
            {resourceSchemas.map((schema) => {
              const value = getResourceValue(schema);
              return (
                <div key={schema.id} className="resource-indicator">
                  <span className="resource-label">{schema.label}</span>
                  <span className="resource-value">{String(value)}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="actions-scroll-area">
          <div className="story-tabs" role="tablist" aria-label="Story tabs">
            <button
              className={`story-tab ${activeTab === "scene" ? "story-tab--active" : ""}`}
              onClick={() => setActiveTab("scene")}
              type="button"
              role="tab"
              aria-selected={activeTab === "scene"}
            >
              Scene
            </button>
            <button
              className={`story-tab ${activeTab === "history" ? "story-tab--active" : ""}`}
              onClick={() => setActiveTab("history")}
              type="button"
              role="tab"
              aria-selected={activeTab === "history"}
              disabled={!hasHistory}
            >
              History {hasHistory ? `(${events.length - 1})` : ""}
            </button>
          </div>

          <div className="story-panel">
            {activeTab === "scene" && (
              <div className="chronicle-wrap">
                <div className="chronicle-card">
                  <div className="chronicle-label">The Story So Far</div>
                  {currentMessage ? (
                    <div className="chronicle-text markdown-content">
                      <ReactMarkdown>{currentMessage}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="chronicle-text" style={{ color: "var(--text-dim)" }}>Your adventure begins...</div>
                  )}
                  {sessionSummary && (
                    <div className="chronicle-summary">
                      <strong>Summary:</strong> {sessionSummary}
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === "history" && (
              hasHistory ? (
                <div className="history-list history-list--tab">
                  {events.slice(0, -1).reverse().map((event) => (
                    <div key={event.id} className="history-item">
                      <div className="history-action">▸ {event.actionText}</div>
                      <div className="history-msg markdown-content">
                        <ReactMarkdown>{event.message}</ReactMarkdown>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="history-empty">No previous turns yet.</div>
              )
            )}
          </div>
        </div>

        {suggestedActions.length > 0 && (
          <div className="suggestions-wrap">
            {suggestedActions.map((action) => (
              <button
                key={action.id}
                className="suggestion-chip"
                onClick={() => onSendAction(action.prompt)}
                disabled={isActionPending}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}

        {serverStatus && (
          <div style={{
            padding: "8px 14px",
            margin: "0 0 6px",
            borderRadius: "var(--radius-sm)",
            background: "rgba(180, 120, 0, 0.12)",
            border: "1px solid rgba(220, 160, 0, 0.3)",
            color: "#c8a020",
            fontSize: 13,
            lineHeight: 1.5,
          }}>
            {serverStatus}
          </div>
        )}

        <div className="action-footer">
          <input
            className="od-input action-input"
            value={actionText}
            onChange={(e) => setActionText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isActionPending) {
                onSendAction(actionText);
              }
            }}
            placeholder="What do you do?"
            disabled={isActionPending}
          />
          <button
            className="od-btn od-btn-primary"
            onClick={() => onSendAction(actionText)}
            disabled={isActionPending || !actionText.trim()}
          >
            {isActionPending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
};
