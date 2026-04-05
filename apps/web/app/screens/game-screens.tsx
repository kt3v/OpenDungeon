"use client";

import { useState } from "react";

type Campaign = {
  id: string;
  title: string;
};

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

type SuggestedAction = {
  id: string;
  label: string;
  prompt: string;
};

type ResourceSource = "character" | "characterState" | "worldState";
type ResourceType = "number" | "text" | "list" | "boolean";
type ResourceSchema = {
  id: string;
  label: string;
  source: ResourceSource;
  stateKey: string;
  type: ResourceType;
  defaultValue?: string | number | boolean | unknown[];
  display?: "compact" | "badge";
};

const resolveDotPath = (obj: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>(
    (acc, key) =>
      acc && typeof acc === "object" && !Array.isArray(acc)
        ? (acc as Record<string, unknown>)[key]
        : undefined,
    obj
  );

const resolveResourceValue = (
  schema: ResourceSchema,
  character: SessionCharacter,
  characterState: Record<string, unknown>,
  worldState: Record<string, unknown>
): unknown => {
  const src =
    schema.source === "character"
      ? (character as unknown as Record<string, unknown>)
      : schema.source === "characterState"
        ? characterState
        : worldState;
  const val = resolveDotPath(src, schema.stateKey);
  return val === undefined || val === null ? (schema.defaultValue ?? "—") : val;
};

const formatResourceValue = (value: unknown, type: ResourceType): string => {
  if (type === "list") {
    if (!Array.isArray(value)) return String(value);
    if (value.length === 0) return "empty";
    return value
      .map((item) =>
        item && typeof item === "object" && "label" in item
          ? (item as { label: string }).label
          : String(item)
      )
      .join(", ");
  }
  if (type === "boolean") return value ? "yes" : "no";
  return String(value);
};

type ResourceIndicatorsProps = {
  schemas: ResourceSchema[];
  character: SessionCharacter;
  characterState: Record<string, unknown>;
  worldState: Record<string, unknown>;
};

export function ResourceIndicators({
  schemas,
  character,
  characterState,
  worldState,
}: ResourceIndicatorsProps) {
  if (schemas.length === 0) return null;
  return (
    <div className="resource-indicators">
      {schemas.map((schema) => {
        const raw = resolveResourceValue(schema, character, characterState, worldState);
        return (
          <div key={schema.id} className="resource-indicator">
            <span className="resource-label">{schema.label}</span>
            <span className="resource-value">{formatResourceValue(raw, schema.type)}</span>
          </div>
        );
      })}
    </div>
  );
}

type SessionEvent = {
  id: string;
  playerId: string;
  actionText: string;
  message: string;
  createdAt: string;
};

// ── Auth ────────────────────────────────────────────────────────────────────

type AuthScreenProps = {
  email: string;
  password: string;
  language: string;
  isLoading: boolean;
  error: string;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setLanguage: (value: string) => void;
  onLogin: () => void;
  onRegister: () => void;
};

export function AuthScreen(props: AuthScreenProps) {
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") props.onLogin();
  };

  return (
    <div className="auth-root">
      <div className="auth-card">
        <div className="auth-logo">⚔</div>
        <h1 className="auth-title">Open Dungeon</h1>
        <p className="auth-subtitle">Enter the realm</p>

        <div className="auth-fields">
          <div className="field-group">
            <label className="field-label">Email</label>
            <input
              className="od-input"
              type="email"
              value={props.email}
              onChange={(e) => props.setEmail(e.target.value)}
              onKeyDown={handleKey}
              placeholder="hero@example.com"
              autoComplete="email"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Password</label>
            <input
              className="od-input"
              type="password"
              value={props.password}
              onChange={(e) => props.setPassword(e.target.value)}
              onKeyDown={handleKey}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>
          <div className="field-group">
            <label className="field-label">Language / Language</label>
            <input
              className="od-input"
              type="text"
              value={props.language}
              onChange={(e) => props.setLanguage(e.target.value)}
              onKeyDown={handleKey}
              placeholder="e.g. Spain, Belarussian, German"
              autoComplete="off"
            />
          </div>
        </div>

        {props.error && <p className="auth-error">{props.error}</p>}

        <div className="auth-actions">
          <button className="od-btn od-btn-primary" onClick={props.onLogin} disabled={props.isLoading}>
            {props.isLoading ? "Signing in…" : "Sign In"}
          </button>
          <button className="od-btn od-btn-ghost" onClick={props.onRegister} disabled={props.isLoading}>
            Create Account
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Campaign ────────────────────────────────────────────────────────────────

type DiscoverableCampaign = {
  id: string;
  title: string;
  membersCount: number;
};

type CampaignScreenProps = {
  campaigns: Campaign[];
  discoverableCampaigns: DiscoverableCampaign[];
  selectedCampaignId: string;
  newCampaignTitle: string;
  setNewCampaignTitle: (v: string) => void;
  setSelectedCampaignId: (v: string) => void;
  onCreateCampaign: () => void;
  onDeleteCampaign: (id: string) => void;
  onJoinDiscoverable: (id: string) => void;
  onJoin: () => void;
  onBack: () => void;
};

export function CampaignScreen(props: CampaignScreenProps) {
  const [showCreate, setShowCreate] = useState(false);

  const selected = props.campaigns.find((c) => c.id === props.selectedCampaignId);

  return (
    <div className="screen-root">
      <div className="screen-header">
        <div className="screen-header-left">
          <button className="od-btn od-btn-ghost od-btn-sm back-btn" onClick={props.onBack}>← Back</button>
          <h2 className="screen-title">Campaigns</h2>
        </div>
        <button className="od-btn od-btn-icon" onClick={() => setShowCreate((v) => !v)} title="New campaign">
          {showCreate ? "✕" : "+ New"}
        </button>
      </div>

      {showCreate && (
        <div className="create-row">
          <input
            className="od-input"
            value={props.newCampaignTitle}
            onChange={(e) => props.setNewCampaignTitle(e.target.value)}
            placeholder="Campaign name…"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                props.onCreateCampaign();
                setShowCreate(false);
              }
            }}
            autoFocus
          />
          <button
            className="od-btn od-btn-primary"
            onClick={() => {
              props.onCreateCampaign();
              setShowCreate(false);
            }}
          >
            Create
          </button>
        </div>
      )}

      <div className="list-area">
        {props.campaigns.length === 0 && props.discoverableCampaigns.length === 0 && (
          <p className="list-empty">No campaigns yet. Create one above.</p>
        )}

        {props.campaigns.map((campaign) => {
          const isSelected = campaign.id === props.selectedCampaignId;
          return (
            <div
              key={campaign.id}
              className={`list-item ${isSelected ? "list-item--selected" : ""}`}
              onClick={() => props.setSelectedCampaignId(campaign.id)}
            >
              <span className="list-item-icon">{isSelected ? "▶" : "◦"}</span>
              <span className="list-item-label">{campaign.title}</span>
              <span className="list-item-id">{campaign.id.slice(0, 6)}</span>
              <button
                className="list-item-delete"
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDeleteCampaign(campaign.id);
                }}
              >
                ✕
              </button>
            </div>
          );
        })}

        {props.discoverableCampaigns.length > 0 && (
          <>
            <p className="list-section-label">Open to join</p>
            {props.discoverableCampaigns.map((campaign) => (
              <div key={campaign.id} className="list-item list-item--discoverable">
                <span className="list-item-icon">◦</span>
                <span className="list-item-label">{campaign.title}</span>
                <span className="list-item-id">{campaign.membersCount} player{campaign.membersCount !== 1 ? "s" : ""}</span>
                <button
                  className="od-btn od-btn-sm od-btn-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onJoinDiscoverable(campaign.id);
                  }}
                >
                  Join
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {selected && (
        <div className="selection-footer">
          <div className="selection-info">
            <span className="selection-name">{selected.title}</span>
          </div>
          <button className="od-btn od-btn-primary od-btn-lg" onClick={props.onJoin}>
            Enter →
          </button>
        </div>
      )}
    </div>
  );
}

// ── Session ─────────────────────────────────────────────────────────────────

type SessionScreenProps = {
  sessions: Session[];
  selectedSessionId: string;
  availableClasses: string[];
  setSelectedSessionId: (v: string) => void;
  onStartSession: (name: string, className: string) => void;
  onEndSession: () => void;
  onContinue: () => void;
  onBack: () => void;
};

export function SessionScreen(props: SessionScreenProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [charName, setCharName] = useState("");
  const [charClass, setCharClass] = useState(props.availableClasses[0] ?? "");

  const activeSessions = props.sessions.filter((s) => s.status === "active");
  const selected = activeSessions.find((s) => s.id === props.selectedSessionId);

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  const handleCreate = () => {
    if (!charName.trim() || !charClass) return;
    props.onStartSession(charName.trim(), charClass);
    setCharName("");
    setShowCreate(false);
  };

  return (
    <div className="screen-root">
      <div className="screen-header">
        <div className="screen-header-left">
          <button className="od-btn od-btn-ghost od-btn-sm back-btn" onClick={props.onBack}>← Back</button>
          <h2 className="screen-title">Characters</h2>
        </div>
        <button className="od-btn od-btn-icon" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? "✕" : "+ New"}
        </button>
      </div>

      {showCreate && (
        <div className="create-character-form">
          <div className="field-group">
            <label className="field-label">Name</label>
            <input
              className="od-input"
              value={charName}
              onChange={(e) => setCharName(e.target.value)}
              placeholder="Character name…"
              onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
              autoFocus
            />
          </div>
          <div className="field-group">
            <label className="field-label">Class</label>
            <div className="class-chips">
              {props.availableClasses.map((cls) => (
                <button
                  key={cls}
                  className={`class-chip ${charClass === cls ? "class-chip--selected" : ""}`}
                  onClick={() => setCharClass(cls)}
                >
                  {cls}
                </button>
              ))}
            </div>
          </div>
          <button
            className="od-btn od-btn-primary"
            onClick={handleCreate}
            disabled={!charName.trim() || !charClass}
          >
            Create Character
          </button>
        </div>
      )}

      <div className="list-area">
        {activeSessions.length === 0 && (
          <p className="list-empty">No active characters. Create one above.</p>
        )}
        {activeSessions.map((session) => {
          const isSelected = session.id === props.selectedSessionId;
          return (
            <div
              key={session.id}
              className={`list-item ${isSelected ? "list-item--selected" : ""}`}
              onClick={() => props.setSelectedSessionId(session.id)}
            >
              <span className="list-item-icon">{isSelected ? "▶" : "◦"}</span>
              <div className="list-item-col">
                <span className="list-item-label">{session.character.name}</span>
                <span className="list-item-meta">
                  {session.character.className} · Lv {session.character.level} · {session.character.hp} HP · {fmt(session.createdAt)}
                </span>
              </div>
              <span className="session-badge session-badge--active">Active</span>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="selection-footer">
          <div className="selection-info">
            <span className="selection-name">{selected.character.name}</span>
            <span className="selection-chars">
              {selected.character.className} · Lv {selected.character.level} · {selected.character.hp} HP
            </span>
          </div>
          <div className="footer-actions">
            <button
              className="od-btn od-btn-ghost od-btn-sm"
              onClick={props.onEndSession}
              title="End this session"
            >
              End
            </button>
            <button className="od-btn od-btn-primary od-btn-lg" onClick={props.onContinue}>
              Play →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Actions ─────────────────────────────────────────────────────────────────

type ActionsScreenProps = {
  actionText: string;
  suggestedActions: SuggestedAction[];
  events: SessionEvent[];
  currentMessage: string;
  sessionSummary: string;
  isActionPending: boolean;
  setActionText: (value: string) => void;
  onSendAction: (prompt: string) => void;
  onBack: () => void;
  resourceSchemas: ResourceSchema[];
  sessionCharacter: SessionCharacter;
  characterState: Record<string, unknown>;
  worldState: Record<string, unknown>;
};

export function ActionsScreen(props: ActionsScreenProps) {
  const narrativeText =
    props.currentMessage.trim() ||
    "The dungeon holds its breath. Make your move and let the story unfold.";

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !props.isActionPending) {
      props.onSendAction(props.actionText);
    }
  };

  return (
    <div className="actions-root">
      {/* Back nav */}
      <div className="actions-topbar">
        <button className="od-btn od-btn-ghost od-btn-sm back-btn" onClick={props.onBack}>← Characters</button>
      </div>

      <ResourceIndicators
        schemas={props.resourceSchemas}
        character={props.sessionCharacter}
        characterState={props.characterState}
        worldState={props.worldState}
      />

      {/* Chronicle */}
      <div className="chronicle-wrap">
        <article className="chronicle-card">
          <p className="chronicle-label">Chronicle</p>
          <p className="chronicle-text">{narrativeText}</p>
          {props.sessionSummary && (
            <p className="chronicle-summary">{props.sessionSummary}</p>
          )}
        </article>
      </div>

      {/* History (collapsed, expandable) */}
      {props.events.length > 1 && (
        <details className="history-details">
          <summary className="history-summary">
            History ({props.events.length} events)
          </summary>
          <div className="history-list">
            {props.events.slice(0, -1).map((ev) => (
              <div key={ev.id} className="history-item">
                <span className="history-action">▷ {ev.actionText}</span>
                <p className="history-msg">{ev.message}</p>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Input dock */}
      <div className="action-dock">
        {props.suggestedActions.length > 0 && (
          <div className="suggestions-wrap">
            {props.suggestedActions.map((action) => (
              <button
                key={action.id}
                className="suggestion-chip"
                onClick={() => props.onSendAction(action.prompt)}
                disabled={props.isActionPending}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
        <div className="action-dock-inner">
          <input
            className="od-input action-input"
            value={props.actionText}
            onChange={(e) => props.setActionText(e.target.value)}
            onKeyDown={handleKey}
            placeholder="What do you do?"
            disabled={props.isActionPending}
          />
          <button
            className="od-btn od-btn-primary"
            onClick={() => props.onSendAction(props.actionText)}
            disabled={props.isActionPending}
          >
            {props.isActionPending ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
