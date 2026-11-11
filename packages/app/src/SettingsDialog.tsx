import { useEffect, useRef, useState } from 'react';
import { errorMessage } from './bridge';
import type {
  JoymindBridge, Preferences, ProviderDefinition, SecretProviderId, SecretSettings,
} from './bridge';
import { useI18n } from './i18n';

export function SettingsDialog({ bridge, catalog, preferences, settings, onPreferences, onSettings, onClose }: {
  bridge: JoymindBridge;
  catalog: ProviderDefinition[];
  preferences: Preferences;
  settings: SecretSettings | undefined;
  onPreferences: (preferences: Preferences) => void;
  onSettings: (settings: SecretSettings) => void;
  onClose: () => void;
}) {
  const { locale, t, setLocale } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const remoteProviders = catalog.filter((provider) => provider.id !== 'scripted');
  const [selected, setSelected] = useState<SecretProviderId>(preferences.provider === 'scripted' ? 'deepseek' : preferences.provider);
  const definition = remoteProviders.find((provider) => provider.id === selected) ?? remoteProviders[0];
  const [models, setModels] = useState(preferences.models);
  const [baseUrls, setBaseUrls] = useState(preferences.baseUrls);
  const [modelListBaseUrls, setModelListBaseUrls] = useState(preferences.modelListBaseUrls);
  const [fetchedModels, setFetchedModels] = useState<Partial<Record<SecretProviderId, string[]>>>({});
  const [permissionMode, setPermissionMode] = useState(preferences.permissionMode);
  const [runDetail, setRunDetail] = useState(preferences.runDetail);
  const [showToolTimeline, setShowToolTimeline] = useState(preferences.showToolTimeline);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'preferences' | 'key' | 'delete' | 'test' | 'models'>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const status = settings?.providers.find((provider) => provider.provider === selected);
  const model = models[selected] ?? definition?.defaultModel ?? '';
  const baseUrl = baseUrls[selected] ?? '';
  const modelListBaseUrl = modelListBaseUrls[selected] ?? '';
  const availableModels = [...new Set([...(fetchedModels[selected] ?? definition?.models ?? []), model])].filter(Boolean);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  if (!definition) return null;

  function chooseProvider(provider: SecretProviderId) {
    setSelected(provider);
    setApiKey('');
    setError('');
    setFeedback('');
  }

  function nextPreferences(): Preferences {
    const nextBaseUrls = { ...baseUrls };
    const nextModelListBaseUrls = { ...modelListBaseUrls };
    if (baseUrl.trim()) nextBaseUrls[selected] = baseUrl.trim();
    else delete nextBaseUrls[selected];
    if (modelListBaseUrl.trim()) nextModelListBaseUrls[selected] = modelListBaseUrl.trim();
    else delete nextModelListBaseUrls[selected];
    return {
      ...preferences, provider: selected, models: { ...models, [selected]: model.trim() },
      baseUrls: nextBaseUrls, modelListBaseUrls: nextModelListBaseUrls,
      permissionMode, runDetail, showToolTimeline,
    };
  }

  async function savePreferences(showFeedback = true): Promise<Preferences | undefined> {
    if (!model.trim()) return undefined;
    setBusy('preferences');
    setError('');
    try {
      const next = await bridge.preferences.save(nextPreferences());
      onPreferences(next);
      if (showFeedback) setFeedback(t.settingsSaved);
      return next;
    } catch (cause) {
      setError(errorMessage(cause, t.operationFailed));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    setBusy('key');
    setError('');
    setFeedback('');
    try {
      await bridge.preferences.save(nextPreferences()).then(onPreferences);
      onSettings(await bridge.secrets.save(selected, apiKey.trim()));
      setApiKey('');
      setFeedback(t.settingsSaved);
    } catch (cause) {
      setError(errorMessage(cause, t.operationFailed));
    } finally {
      setBusy(undefined);
    }
  }

  async function removeKey() {
    setBusy('delete');
    setError('');
    setFeedback('');
    try {
      onSettings(await bridge.secrets.remove(selected));
    } catch (cause) {
      setError(errorMessage(cause, t.operationFailed));
    } finally {
      setBusy(undefined);
    }
  }

  async function fetchModels() {
    if (selected !== 'openai-compatible' && !status?.configured && !apiKey.trim()) {
      setError(t.setupRequired);
      return;
    }
    if (selected === 'qwen' && !modelListBaseUrl.trim()) {
      setError(t.qwenListRequired);
      return;
    }
    setBusy('models');
    setError('');
    setFeedback('');
    try {
      const result = await bridge.listModels({
        provider: selected,
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(modelListBaseUrl.trim() ? { modelListBaseUrl: modelListBaseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setFetchedModels((previous) => ({ ...previous, [selected]: result.models }));
      setFeedback(result.models.length ? t.modelsFetched(result.models.length) : t.noModelsReturned);
    } catch (cause) {
      setError(`${t.modelFetchFailed}: ${errorMessage(cause, t.operationFailed)}`);
    } finally {
      setBusy(undefined);
    }
  }

  async function testConnection() {
    if (selected !== 'openai-compatible' && !status?.configured && !apiKey.trim()) {
      setError(t.setupRequired);
      return;
    }
    setBusy('test');
    setError('');
    setFeedback('');
    try {
      await bridge.testConnection({
        provider: selected, model: model.trim(),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setFeedback(t.connectionSucceeded);
    } catch (cause) {
      setError(`${t.connectionFailed}: ${errorMessage(cause, t.operationFailed)}`);
    } finally {
      setBusy(undefined);
    }
  }

  return <dialog ref={dialogRef} className="settings-dialog" aria-labelledby="settings-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="settings-layout">
      <header className="settings-header">
        <div><span className="eyebrow">{t.settings}</span><h2 id="settings-title">{t.settingsTitle}</h2></div>
        <button type="button" className="icon-button" aria-label={t.close} title={t.close} onClick={onClose} autoFocus>×</button>
      </header>
      <div className="settings-content">
        <label className="language-setting"><span>{t.language}</span><select aria-label={t.language} value={locale} onChange={(event) => setLocale(event.target.value as typeof locale)}><option value="zh-CN">简体中文</option><option value="en-US">English</option></select></label>
        <section className="general-settings" aria-labelledby="general-settings-title">
          <h3 id="general-settings-title">{t.general}</h3>
          <div className="general-settings-grid">
            <label><span>{t.permissionMode}</span><select aria-label={t.permissionMode} value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as Preferences['permissionMode'])}>{(['ask', 'auto', 'autonomous'] as const).map((mode) => <option key={mode} value={mode}>{t.permissionModes[mode]}</option>)}</select></label>
            <label><span>{t.runDetail}</span><select aria-label={t.runDetail} value={runDetail} onChange={(event) => setRunDetail(event.target.value as Preferences['runDetail'])}><option value="detailed">{t.runDetails.detailed}</option><option value="compact">{t.runDetails.compact}</option></select></label>
            <label className="checkbox-setting"><input type="checkbox" checked={showToolTimeline} onChange={(event) => setShowToolTimeline(event.target.checked)} /><span>{t.showToolTimeline}</span></label>
          </div>
          <p className={`small permission-hint ${permissionMode === 'autonomous' ? 'error-text' : 'muted'}`}>{t.permissionHints[permissionMode]}</p>
        </section>
        <div className="settings-grid">
          <nav className="provider-nav" aria-label={t.provider}>
            {remoteProviders.map((provider) => <button type="button" key={provider.id} aria-label={provider.name} className={selected === provider.id ? 'selected' : ''} onClick={() => chooseProvider(provider.id as SecretProviderId)}>
              <span>{provider.name}</span>{settings?.providers.find((item) => item.provider === provider.id)?.configured && <span className="configured-dot" title={t.configured} />}
            </button>)}
          </nav>
          <section className="provider-form">
            <div className="provider-form-title"><div><h3>{definition.name}</h3><span className="muted small">{definition.protocol}</span></div><span className={status?.configured ? 'secure-ok small' : 'muted small'}>{status?.configured ? t.configured : t.notConfigured}</span></div>
            <label><span>{t.model}</span><input aria-label={t.model} required list="settings-models" value={model} onChange={(event) => { setModels((previous) => ({ ...previous, [selected]: event.target.value })); setFeedback(''); }} /><datalist id="settings-models">{availableModels.map((item) => <option key={item} value={item} />)}</datalist></label>
            <p className="muted small field-hint">{definition.modelList === 'none' ? t.modelListUnsupported : t.customModelHelp}</p>
            <label><span>{t.baseUrl}</span><input aria-label={t.baseUrl} type="url" value={baseUrl} placeholder={definition.defaultBaseUrl ?? 'https://example.com/v1'} onChange={(event) => { setBaseUrls((previous) => ({ ...previous, [selected]: event.target.value })); setFetchedModels((previous) => ({ ...previous, [selected]: [] })); setFeedback(''); }} /></label>
            <p className="muted small field-hint">{t.baseUrlHint}{definition.apiKeyEnv && <> {t.apiKey}: <code>{definition.apiKeyEnv}</code></>}</p>
            {definition.modelList === 'qwen' && <><label><span>{t.modelListBaseUrl}</span><input aria-label={t.modelListBaseUrl} type="url" value={modelListBaseUrl} placeholder="https://<workspace>.cn-beijing.maas.aliyuncs.com" onChange={(event) => { setModelListBaseUrls((previous) => ({ ...previous, [selected]: event.target.value })); setFetchedModels((previous) => ({ ...previous, [selected]: [] })); setFeedback(''); }} /></label><p className="muted small field-hint">{t.modelListBaseUrlHint}</p></>}
            <label><span>{t.apiKey}</span><input aria-label={t.apiKey} type="password" autoComplete="off" spellCheck={false} placeholder={status?.configured ? t.apiKeyPlaceholder : t.apiKeyPlaceholder} value={apiKey} onChange={(event) => setApiKey(event.target.value)} /></label>
            <div className="credential-status">{status?.source === 'encrypted' && <span className="secure-ok">{t.encryptedKey}</span>}{status?.source === 'environment' && <span className="secure-ok">{t.environmentKey}</span>}{!status?.configured && <span className="muted">{t.setupRequired}</span>}</div>
            <p className={`small ${settings?.encryptionAvailable ? 'secure-ok' : 'error-text'}`}>{settings?.encryptionAvailable ? t.secureStorage : t.encryptionUnavailable}</p>
            <p className="muted small settings-privacy">{t.providerSettingsHint}</p>
            {error && <div className="settings-feedback error-text" role="alert">{error}</div>}
            {feedback && <div className="settings-feedback secure-ok" role="status">{feedback}</div>}
            <div className="settings-actions">
              <button type="button" className="button secondary" disabled={busy !== undefined || definition.modelList === 'none'} title={definition.modelList === 'none' ? t.modelListUnsupported : undefined} onClick={() => void fetchModels()}>{busy === 'models' ? t.fetchingModels : t.fetchModels}</button>
              <button type="button" className="button secondary" disabled={busy !== undefined || !model.trim()} onClick={() => void testConnection()}>{busy === 'test' ? t.testing : t.testConnection}</button>
              <button type="button" className="button secondary" disabled={busy !== undefined || !apiKey.trim() || !settings?.encryptionAvailable} onClick={() => void saveKey()}>{t.saveKey}</button>
              {status?.source === 'encrypted' && <button type="button" className="button ghost danger-text" disabled={busy !== undefined} onClick={() => void removeKey()}>{t.deleteKey}</button>}
              <button type="button" className="button primary save-settings" disabled={busy !== undefined || !model.trim()} onClick={() => void savePreferences()}>{t.saveSettings}</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  </dialog>;
}
