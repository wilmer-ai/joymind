import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { RunCommand, RunSnapshot, RunStatus } from '@joymind/core';
import type {
  JoymindBridge, Locale, Preferences, ProviderDefinition, ProviderId, SecretSettings, StartRunInput,
} from './bridge';
import { errorMessage } from './bridge';
import { I18nProvider, systemLocale, useI18n } from './i18n';
import { MarkdownContent } from './MarkdownContent';
import { deriveRunView, formatJson, toolOutput, writeDiff } from './run-view';
import type { ApprovalView, ToolView } from './run-view';
import { appReducer, initialAppState } from './state';
import type { RunState } from './state';
import { SettingsDialog } from './SettingsDialog';

const terminalStatuses: RunStatus[] = ['completed', 'failed', 'cancelled'];
const scriptedDefinition: ProviderDefinition = {
  id: 'scripted', name: 'Scripted (offline)', protocol: 'scripted', modelList: 'none', defaultModel: 'scripted-default', models: ['scripted-default'], customEndpoint: false,
};

function newCommandId(): string {
  return crypto.randomUUID();
}

function time(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function StatusBadge({ status }: { status: RunStatus }) {
  const { t } = useI18n();
  return <span className={`status status-${status}`}><span aria-hidden="true" className="status-dot" />{t.statuses[status] ?? status}</span>;
}

function ApprovalCard({ approval, disabled, onCommand }: {
  approval: ApprovalView;
  disabled: boolean;
  onCommand: (command: RunCommand) => void;
}) {
  const { t } = useI18n();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const args = typeof approval.arguments === 'object' && approval.arguments !== null ? approval.arguments as Record<string, unknown> : {};
  const proposedContent = approval.name === 'fs.write' && typeof args.content === 'string' ? args.content : undefined;
  const shellCommand = approval.name === 'shell.exec' && typeof args.command === 'string' ? args.command : undefined;

  return <article className="approval-card" aria-label={`${t.approvals}: ${approval.name}`}>
    <div className="approval-heading"><div><span className="eyebrow">{t.approvals}</span><h3>{approval.name}</h3></div><span className={`risk risk-${approval.risk}`}>{t.risks[approval.risk] ?? approval.risk}</span></div>
    <p className="muted">{t.approvalHint}</p>
    {shellCommand !== undefined && <div className="code-block"><span className="code-label">{t.command}</span><pre>{shellCommand}</pre></div>}
    {approval.diff !== undefined
      ? <div className="code-block diff"><span className="code-label">{t.diff}</span><pre>{approval.diff}</pre></div>
      : proposedContent !== undefined && <div className="code-block write-preview"><span className="code-label">{t.writePreview}</span><pre>{proposedContent}</pre></div>}
    <details className="arguments" open={proposedContent === undefined && shellCommand === undefined}><summary>{t.arguments}</summary><pre>{formatJson(approval.arguments)}</pre></details>
    {rejecting && <label className="reject-reason">{t.rejectReason}<textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} autoFocus /></label>}
    <div className="approval-actions">{!rejecting
      ? <><button type="button" className="button secondary" disabled={disabled} onClick={() => setRejecting(true)}>{t.reject}</button><button type="button" className="button danger" disabled={disabled} onClick={() => onCommand({ commandId: newCommandId(), type: 'approve', approvalId: approval.id })}>{t.approve}</button></>
      : <><button type="button" className="button ghost" disabled={disabled} onClick={() => setRejecting(false)}>{t.back}</button><button type="button" className="button secondary" disabled={disabled} onClick={() => onCommand({ commandId: newCommandId(), type: 'reject', approvalId: approval.id, ...(reason.trim() ? { reason: reason.trim() } : {}) })}>{t.rejecting}</button></>}</div>
  </article>;
}

function ToolTimelineItem({ tool, detailed }: { tool: ToolView; detailed: boolean }) {
  const { t } = useI18n();
  const output = toolOutput(tool.result);
  const diff = writeDiff(tool.result);
  const duration = tool.result?.metadata.durationMs;
  return <li className="tool-item"><div className="tool-marker" aria-hidden="true" /><div className="tool-content">
    <div className="tool-title"><strong>{tool.name}</strong><span className={`tool-status tool-${tool.status}`}>{t.toolStatuses[tool.status] ?? tool.status}</span>{duration !== undefined && <span className="muted small">{duration} ms</span>}</div>
    {detailed && <details className="tool-arguments"><summary>{t.arguments}</summary><pre>{formatJson(tool.arguments)}</pre></details>}
    {detailed && diff && <div className="code-block diff"><span className="code-label">{t.diff}</span><pre>{diff}</pre></div>}
    {detailed && output && <details className="tool-output"><summary>{t.output}{tool.result?.metadata.truncated ? ` (${t.truncated})` : ''}</summary><pre>{output}</pre></details>}
  </div></li>;
}

function Welcome({ onConfigure, onDemo, onExample }: {
  onConfigure: () => void;
  onDemo: () => void;
  onExample: (goal: string) => void;
}) {
  const { t } = useI18n();
  return <section className="empty-state"><div className="empty-mark">J</div><h2>{t.welcomeTitle}</h2><p>{t.welcomeText}</p>
    <div className="welcome-actions"><button type="button" className="button primary" onClick={onConfigure}>{t.configureModels}</button><button type="button" className="button secondary" onClick={onDemo}>{t.offlineDemo}</button></div>
    <div className="example-list"><span className="eyebrow">{t.exampleTitle}</span><button type="button" onClick={() => onExample(t.exampleReview)}>{t.exampleReview}</button><button type="button" onClick={() => onExample(t.exampleReadme)}>{t.exampleReadme}</button></div>
  </section>;
}

function RunDetails({ run, busy, preferences, onCommand, onConfigure, onDemo, onExample, onOpenLink }: {
  run: RunState | undefined;
  busy: boolean;
  preferences: Preferences;
  onCommand: (command: RunCommand) => void;
  onOpenLink: (url: string) => void;
  onConfigure: () => void;
  onDemo: () => void;
  onExample: (goal: string) => void;
}) {
  const { locale, t } = useI18n();
  const snapshot = run?.snapshot;
  const view = useMemo(() => deriveRunView(run?.events ?? []), [run?.events]);
  const pendingApprovals = view.approvals.filter((approval) => approval.decision === 'pending');
  if (!snapshot) return <><Welcome onConfigure={onConfigure} onDemo={onDemo} onExample={onExample} />{run?.error && <p className="error-text">{run.error}</p>}</>;

  return <section className="run-details" aria-live="polite">
    <header className="run-header"><div className="run-heading"><div className="run-meta"><StatusBadge status={snapshot.status} /><span className={`permission-badge permission-${snapshot.permissionMode}`}>{t.permissionModes[snapshot.permissionMode]}</span><span>{time(snapshot.createdAt, locale)}</span><code>{snapshot.id.slice(0, 8)}</code></div><h2>{snapshot.goal}</h2></div>
      <div className="run-controls">
        {['running', 'waiting_for_approval', 'waiting_for_input'].includes(snapshot.status) && <button className="button secondary" type="button" disabled={busy} onClick={() => onCommand({ commandId: newCommandId(), type: 'pause' })}>{t.pause}</button>}
        {['paused', 'interrupted'].includes(snapshot.status) && <button className="button primary" type="button" disabled={busy} onClick={() => onCommand({ commandId: newCommandId(), type: 'resume' })}>{t.resume}</button>}
        {!terminalStatuses.includes(snapshot.status) && <button className="button ghost danger-text" type="button" disabled={busy} onClick={() => onCommand({ commandId: newCommandId(), type: 'cancel', reason: t.cancelReason })}>{t.cancel}</button>}
      </div>
    </header>
    {snapshot.status === 'interrupted' && <div className="notice">{t.interruptedHint}</div>}
    {(snapshot.error || run?.error) && <div className="error-banner" role="alert"><strong>{snapshot.error?.code ?? 'error'}</strong><span>{snapshot.error?.message ?? run?.error}</span></div>}
    {pendingApprovals.length > 0 && <div className="approval-stack">{pendingApprovals.map((approval) => <ApprovalCard key={approval.id} approval={approval} disabled={busy} onCommand={onCommand} />)}</div>}
    <div className={`execution-grid ${preferences.showToolTimeline ? '' : 'without-tools'}`}><section className="conversation panel"><div className="section-heading"><h3>{t.conversation}</h3><span className="muted small">{snapshot.usage.steps} {t.steps} · {snapshot.usage.inputTokens + snapshot.usage.outputTokens} {t.tokens}</span></div>
      <div className="messages">{view.messages.map((message) => <article key={message.id} className={`message message-${message.role}`}><div className="message-role">{message.role === 'user' ? t.user : t.assistant}</div><div className="message-body">{message.role === 'assistant' && message.content ? <MarkdownContent source={message.content} onOpenLink={onOpenLink} /> : message.content || (!message.completed ? <span className="typing">{t.generating}<span>…</span></span> : null)}</div></article>)}</div>
    </section>{preferences.showToolTimeline && <aside className="tools-panel panel"><div className="section-heading"><h3>{t.tools}</h3><span className="count">{view.tools.length}</span></div>{view.tools.length === 0 ? <p className="muted empty-tools">{t.noTools}</p> : <ol className="tool-timeline">{view.tools.map((tool) => <ToolTimelineItem key={tool.id} tool={tool} detailed={preferences.runDetail === 'detailed'} />)}</ol>}</aside>}</div>
  </section>;
}

function WorkspaceApp({ bridge }: { bridge: JoymindBridge }) {
  const { locale, t, setLocale } = useI18n();
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [catalog, setCatalog] = useState<ProviderDefinition[]>([scriptedDefinition]);
  const [preferences, setPreferences] = useState<Preferences>({ locale, workspacePath: '', provider: 'scripted', models: {}, baseUrls: {}, modelListBaseUrls: {}, permissionMode: 'ask', runDetail: 'detailed', showToolTimeline: true });
  const [form, setForm] = useState<StartRunInput>({ workspacePath: '', goal: '', provider: 'scripted', model: scriptedDefinition.defaultModel, permissionMode: 'ask' });
  const [starting, setStarting] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [commandBusy, setCommandBusy] = useState(false);
  const [globalError, setGlobalError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [settings, setSettings] = useState<SecretSettings>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const initialLocale = useRef(locale);
  const currentLocale = useRef(locale);
  const goalInputRef = useRef<HTMLTextAreaElement>(null);
  currentLocale.current = locale;
  const selectedRun = state.selectedRunId ? state.runs[state.selectedRunId] : undefined;
  const definition = catalog.find((provider) => provider.id === form.provider) ?? scriptedDefinition;
  const credentialStatus = form.provider === 'scripted' ? undefined : settings?.providers.find((provider) => provider.provider === form.provider);
  const needsConfiguration = form.provider !== 'scripted' && ((!credentialStatus?.configured && form.provider !== 'openai-compatible') || (form.provider === 'openai-compatible' && !preferences.baseUrls['openai-compatible']));

  const refreshHistory = useCallback(async (offset = 0, append = false) => {
    setHistoryLoading(true);
    try {
      const page = await bridge.listRuns({ limit: 20, offset });
      dispatch({ type: 'history', runs: page.runs, hasMore: page.hasMore, append });
      setGlobalError('');
    } catch (cause) {
      setGlobalError(errorMessage(cause, t.operationFailed));
    } finally {
      setHistoryLoading(false);
    }
  }, [bridge, t.operationFailed]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    void bridge.getCatalog().then(setCatalog).catch((cause: unknown) => setGlobalError(errorMessage(cause, t.operationFailed)));
    void bridge.secrets.getSettings().then(setSettings).catch((cause: unknown) => setGlobalError(errorMessage(cause, t.operationFailed)));
    void bridge.preferences.get().then((saved) => {
      setPreferences(currentLocale.current === initialLocale.current ? saved : { ...saved, locale: currentLocale.current });
      if (currentLocale.current === initialLocale.current) setLocale(saved.locale);
      setForm((previous) => ({ ...previous, workspacePath: saved.workspacePath, provider: saved.provider, model: saved.models[saved.provider] ?? scriptedDefinition.defaultModel, permissionMode: saved.permissionMode }));
      void bridge.getCatalog().then((providers) => {
        const provider = providers.find((item) => item.id === saved.provider);
        if (provider && !saved.models[saved.provider]) setForm((previous) => ({ ...previous, model: provider.defaultModel }));
      }).catch(() => undefined);
    }).catch((cause: unknown) => setGlobalError(errorMessage(cause, t.operationFailed)));
  }, [bridge]);

  useEffect(() => {
    setPreferences((previous) => ({ ...previous, locale }));
  }, [locale]);

  useEffect(() => {
    if (!state.selectedRunId) return;
    const runId = state.selectedRunId;
    let active = true;
    void bridge.getRun(runId).then((snapshot) => {
      if (active) dispatch({ type: 'snapshot', snapshot });
    }).catch((cause: unknown) => {
      if (active) dispatch({ type: 'runError', runId, message: errorMessage(cause, t.operationFailed) });
    });
    const unsubscribe = bridge.subscribe(runId, 0, (event) => {
      if (!active) return;
      dispatch({ type: 'event', event });
      if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) void refreshHistory();
    }, (error) => {
      if (active) dispatch({ type: 'runError', runId, message: error.message });
    });
    return () => { active = false; unsubscribe(); };
  }, [bridge, refreshHistory, state.selectedRunId, t.operationFailed]);

  function applyPreferences(next: Preferences) {
    setPreferences(next);
    setLocale(next.locale);
    const provider = catalog.find((item) => item.id === next.provider);
    setForm((previous) => ({ ...previous, workspacePath: next.workspacePath, provider: next.provider, model: next.models[next.provider] ?? provider?.defaultModel ?? previous.model, permissionMode: next.permissionMode }));
  }

  const selectWorkspace = useCallback(async () => {
    setSelecting(true);
    setGlobalError('');
    try {
      const result = await bridge.selectWorkspace();
      if (!result.path) return;
      setForm((previous) => ({ ...previous, workspacePath: result.path as string }));
      const next = { ...preferences, workspacePath: result.path };
      setPreferences(next);
      await bridge.preferences.save(next);
    } catch (cause) {
      setGlobalError(errorMessage(cause, t.operationFailed));
    } finally {
      setSelecting(false);
    }
  }, [bridge, preferences, t.operationFailed]);

  useEffect(() => bridge.onMenuAction((action) => {
    if (action.action === 'set-locale') setLocale(action.locale);
    if (action.action === 'open-settings') setSettingsOpen(true);
    if (action.action === 'select-workspace') void selectWorkspace();
    if (action.action === 'new-task') {
      dispatch({ type: 'select', runId: '' });
      setForm((previous) => ({ ...previous, goal: '' }));
      goalInputRef.current?.focus();
    }
  }), [bridge, selectWorkspace, setLocale]);

  async function startRun(event?: FormEvent) {
    event?.preventDefault();
    if (!form.workspacePath.trim() || !form.goal.trim() || !form.model.trim()) return;
    if (needsConfiguration) {
      setGlobalError(t.setupHint);
      setSettingsOpen(true);
      return;
    }
    setStarting(true);
    setGlobalError('');
    try {
      const snapshot = await bridge.startRun({ ...form, workspacePath: form.workspacePath.trim(), goal: form.goal.trim(), model: form.model.trim() });
      dispatch({ type: 'snapshot', snapshot });
      dispatch({ type: 'select', runId: snapshot.id });
      setForm((previous) => ({ ...previous, goal: '' }));
      void refreshHistory();
    } catch (cause) {
      setGlobalError(errorMessage(cause, t.operationFailed));
    } finally {
      setStarting(false);
    }
  }

  function goalKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void startRun(); }
  }

  async function sendCommand(command: RunCommand) {
    if (!state.selectedRunId) return;
    setCommandBusy(true);
    try {
      const snapshot = await bridge.command(state.selectedRunId, command);
      dispatch({ type: 'snapshot', snapshot });
      setGlobalError('');
    } catch (cause) {
      setGlobalError(errorMessage(cause, t.operationFailed));
      try { dispatch({ type: 'snapshot', snapshot: await bridge.getRun(state.selectedRunId) }); } catch { /* The next selection retries the stream. */ }
    } finally { setCommandBusy(false); }
  }

  function selectRun(run: RunSnapshot) {
    dispatch({ type: 'snapshot', snapshot: run });
    dispatch({ type: 'select', runId: run.id });
  }

  function chooseProvider(provider: ProviderId) {
    const next = catalog.find((item) => item.id === provider);
    setForm((previous) => ({ ...previous, provider, model: preferences.models[provider] ?? next?.defaultModel ?? '' }));
    setPreferences((previous) => ({ ...previous, provider }));
  }

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark">J</div><div><h1>{t.appName}</h1><p>{t.tagline}</p></div></div>
      <div className="history-heading"><h2>{t.history}</h2><button type="button" className="icon-button" title={t.refresh} aria-label={t.refresh} disabled={historyLoading} onClick={() => void refreshHistory()}>↻</button></div>
      <div className="history-list">{state.history.length === 0 ? <p className="muted small">{historyLoading ? t.loading : t.emptyHistory}</p> : state.history.map((run) => <button type="button" key={run.id} className={`history-item ${state.selectedRunId === run.id ? 'selected' : ''}`} onClick={() => selectRun(run)}><span className="history-goal">{run.goal}</span><span className="history-meta"><StatusBadge status={run.status} /><time>{time(run.createdAt, locale)}</time></span></button>)}</div>
      {state.historyHasMore && <button type="button" className="button ghost load-more" disabled={historyLoading} onClick={() => void refreshHistory(state.history.length, true)}>{t.loadMore}</button>}
      <button type="button" className="sidebar-settings" onClick={() => setSettingsOpen(true)}><span aria-hidden="true">⚙</span>{t.providerSettings}</button>
      <div className="sidebar-footer">{t.localData}</div>
    </aside>
    <main className="main-content"><div className="app-topbar"><span className="privacy-label">{t.localWorkspace}</span><div><label className="top-language"><span className="sr-only">{t.language}</span><select aria-label={t.language} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}><option value="zh-CN">中文</option><option value="en-US">English</option></select></label><button type="button" className="button ghost" onClick={() => setSettingsOpen(true)}>{t.settings}</button></div></div>
      <form className="composer" onSubmit={(event) => void startRun(event)}><div className="composer-title"><span className="eyebrow">{t.newRun}</span><span className="privacy-label">{definition.name}</span></div>
        <div className="composer-fields"><label className="workspace-field"><span>{t.workspace}</span><div className="workspace-input"><input aria-label={t.workspace} required value={form.workspacePath} placeholder={t.workspacePlaceholder} onChange={(event) => setForm((previous) => ({ ...previous, workspacePath: event.target.value }))} /><button type="button" className="button secondary" disabled={selecting} onClick={() => void selectWorkspace()}>{t.chooseFolder}</button></div></label>
          <div className="model-fields"><label><span>{t.provider}</span><select aria-label={t.provider} value={form.provider} onChange={(event) => chooseProvider(event.target.value as ProviderId)}>{catalog.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label><span>{t.model}</span><input aria-label={t.model} required list="composer-models" value={form.model} onChange={(event) => setForm((previous) => ({ ...previous, model: event.target.value }))} /><datalist id="composer-models">{definition.models.map((model) => <option key={model} value={model} />)}</datalist></label></div>
          <div className="permission-select-row"><label><span>{t.permissionMode}</span><select aria-label={t.permissionMode} value={form.permissionMode} onChange={(event) => setForm((previous) => ({ ...previous, permissionMode: event.target.value as Preferences['permissionMode'] }))}>{(['ask', 'auto', 'autonomous'] as const).map((mode) => <option key={mode} value={mode}>{t.permissionModes[mode]}</option>)}</select></label><span className="muted small">{t.permissionHints[form.permissionMode]}</span></div>
        </div>
        {form.permissionMode === 'autonomous' && <div className="notice autonomous-notice">{t.autonomousWarning}</div>}
        {needsConfiguration && <div className="configuration-hint"><span>{t.setupRequired}</span><button type="button" onClick={() => setSettingsOpen(true)}>{t.configureModels}</button></div>}
        <label className="goal-field"><span>{t.goal}</span><textarea ref={goalInputRef} aria-label={t.goal} required rows={3} value={form.goal} placeholder={t.goalPlaceholder} onKeyDown={goalKeyDown} onChange={(event) => setForm((previous) => ({ ...previous, goal: event.target.value }))} /></label>
        <div className="composer-actions"><span className="muted small">{t.securityNotice}</span><button className="button primary start-button" type="submit" disabled={starting || !form.workspacePath.trim() || !form.goal.trim() || !form.model.trim()}>{starting ? t.starting : t.start}</button></div>
      </form>
      {globalError && <div className="global-error" role="alert"><span>{globalError}</span><button type="button" aria-label={t.closeError} onClick={() => setGlobalError('')}>×</button></div>}
      <RunDetails run={selectedRun} busy={commandBusy} preferences={preferences} onOpenLink={(url) => { void bridge.openExternal(url).catch((cause: unknown) => setGlobalError(errorMessage(cause, t.operationFailed))); }} onCommand={(command) => void sendCommand(command)} onConfigure={() => setSettingsOpen(true)} onDemo={() => chooseProvider('scripted')} onExample={(goal) => setForm((previous) => ({ ...previous, goal }))} />
    </main>
    {settingsOpen && <SettingsDialog bridge={bridge} catalog={catalog} preferences={preferences} settings={settings} onPreferences={applyPreferences} onSettings={setSettings} onClose={() => setSettingsOpen(false)} />}
  </div>;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(systemLocale);
  const changeLocale = useCallback((next: Locale) => {
    setLocale(next);
    const bridge = window.joymind as JoymindBridge | undefined;
    if (bridge) void bridge.preferences.get().then((saved) => bridge.preferences.save({ ...saved, locale: next })).catch(() => undefined);
  }, []);
  const bridge = window.joymind as JoymindBridge | undefined;
  return <I18nProvider locale={locale} onLocaleChange={changeLocale}>{bridge ? <WorkspaceApp bridge={bridge} /> : <main className="missing-bridge"><MissingBridge /></main>}</I18nProvider>;
}

function MissingBridge() {
  const { t } = useI18n();
  return <><div className="empty-mark">J</div><h1>{t.desktopRequired}</h1><p>{t.desktopRequiredHint}</p></>;
}
