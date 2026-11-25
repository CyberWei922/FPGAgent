import {
  Check,
  CheckCircle2,
  Cpu,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Wifi,
  X,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CustomModelSelect } from './CustomSelect';
import {
  createLLMClient,
  fetchOpenAIModels,
  getProviderPreset,
  getSuggestedModelOptions,
  inferProviderId,
  isAllowedBaseUrl,
  isApiKeyOptional,
  isLocalDevOrigin,
  isLocalOrPrivateBaseUrl,
  normalizeBaseUrl,
  PROVIDER_PRESETS,
  saveAppPreferences,
  saveByokConfig,
  type AppPreferences,
  type ByokConfig,
} from '../services/llmClient';
import {
  ACCENT_PRESETS,
  contrastInkOn,
  type AccentPresetId,
  type ThemeMode,
  type ThemePreferences,
} from '../services/theme';
import { isLLMError, type LLMModelOption, type LLMProviderId } from '../types/contracts';

type SettingsSection = 'api' | 'appearance';

interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export function ApiSettings({
  config,
  theme,
  prefs,
  remainingQuota,
  initialSection = 'api',
  onSaveApi,
  onThemeChange,
  onPrefsChange,
  onClose,
}: {
  config: ByokConfig | null;
  theme: ThemePreferences;
  prefs: AppPreferences;
  remainingQuota?: number;
  initialSection?: SettingsSection;
  onSaveApi: (config: ByokConfig | null) => void;
  onThemeChange: (next: ThemePreferences) => void;
  onPrefsChange: (next: AppPreferences) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);

  const initialProvider: LLMProviderId = config
    ? config.providerId ?? inferProviderId(config.baseUrl)
    : 'site-default';

  const [providerId, setProviderId] = useState<LLMProviderId>(initialProvider);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [apiKey, setApiKey] = useState(config?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [customModelInput, setCustomModelInput] = useState(
    (initialProvider === 'local-gateway' || initialProvider === 'custom') &&
      !(config?.cachedModels && config.cachedModels.length > 0),
  );
  const [useLocalProxy, setUseLocalProxy] = useState<boolean>(
    config?.useLocalProxy ?? (initialProvider === 'local-gateway' || isLocalOrPrivateBaseUrl(config?.baseUrl ?? '')),
  );

  const [fetchedModels, setFetchedModels] = useState<LLMModelOption[]>(() =>
    config?.cachedModels?.length
      ? config.cachedModels
      : getSuggestedModelOptions(initialProvider, config?.model),
  );
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsHint, setModelsHint] = useState<string>('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  const activePreset = getProviderPreset(providerId);
  const isCustomProvider = providerId !== 'site-default';
  const keyOptional = isCustomProvider && isApiKeyOptional(baseUrl, providerId);
  const localDevAvailable = isLocalDevOrigin();

  function selectProvider(nextId: LLMProviderId) {
    setProviderId(nextId);
    setError('');
    setTestResult(null);
    setModelsHint('');
    setCustomModelInput(false);

    if (nextId === 'site-default') return;

    const preset = getProviderPreset(nextId);
    if (nextId === 'local-gateway') {
      const nextUrl = isLocalOrPrivateBaseUrl(baseUrl) ? baseUrl : preset?.baseUrl ?? 'http://127.0.0.1:11434/v1';
      setBaseUrl(nextUrl);
      if (activePreset && activePreset.id !== 'local-gateway') setModel('');
      setFetchedModels(getSuggestedModelOptions(nextId, ''));
      setCustomModelInput(true);
      setUseLocalProxy(true);
      return;
    }

    if (preset && nextId !== 'custom') {
      setBaseUrl(preset.baseUrl);
      setModel(preset.defaultModel);
      setFetchedModels(getSuggestedModelOptions(nextId, preset.defaultModel));
      setUseLocalProxy(false);
    } else if (nextId === 'custom') {
      if (activePreset && activePreset.id !== 'custom') {
        setBaseUrl('');
        setModel('');
      }
      setFetchedModels([]);
      setCustomModelInput(true);
      setUseLocalProxy(false);
    }
  }

  async function refreshModels() {
    if (!isCustomProvider) return;
    setError('');
    setModelsHint('');
    const normalized = normalizeBaseUrl(baseUrl);
    if (!isAllowedBaseUrl(normalized, providerId)) {
      setError(
        providerId === 'local-gateway'
          ? '请先填写有效的本地/内网网关地址（如 http://127.0.0.1:11434/v1 或 http://192.168.x.x:8000/v1）。'
          : '请先填写有效的 HTTPS API Base URL（内网地址请选择「本地 / 内网网关」）。',
      );
      return;
    }
    if (!isApiKeyOptional(normalized, providerId) && !apiKey.trim()) {
      setError('请先填写 API Key，再自动获取模型列表。');
      return;
    }

    setModelsLoading(true);
    try {
      const list = await fetchOpenAIModels(normalized, apiKey.trim(), {
        providerId,
        useLocalProxy: localDevAvailable ? useLocalProxy : false,
      });
      if (list.length === 0) {
        const fallback = getSuggestedModelOptions(providerId, model);
        setFetchedModels(fallback);
        setModelsHint('接口返回了空列表，已回退为推荐模型列表。');
      } else {
        setFetchedModels(list);
        const preferred =
          !model.trim() || !list.some((item) => item.id === model.trim())
            ? activePreset?.defaultModel && list.some((m) => m.id === activePreset.defaultModel)
              ? activePreset.defaultModel
              : list[0].id
            : model.trim();
        setModel(preferred);
        setCustomModelInput(false);
        setModelsHint(`已从网关同步 ${list.length} 个可用模型。`);
        if (config && normalizeBaseUrl(config.baseUrl) === normalized) {
          const synced: ByokConfig = {
            ...config,
            providerId,
            model: preferred,
            cachedModels: list.slice(0, 80),
            useLocalProxy: localDevAvailable ? useLocalProxy : false,
          };
          try {
            saveByokConfig(synced);
            onSaveApi(synced);
          } catch {
            // ignore storage errors on background sync
          }
        }
      }
    } catch (err) {
      const fallback = getSuggestedModelOptions(providerId, model);
      setFetchedModels(fallback);
      const reason = isLLMError(err) ? err.message : '拉取失败';
      setModelsHint(`自动拉取未成功（${reason}），可手动填写模型名称。`);
    } finally {
      setModelsLoading(false);
    }
  }

  async function runConnectionTest() {
    setError('');
    setTestResult(null);
    setTesting(true);
    try {
      if (!isCustomProvider) {
        const proxyClient = createLLMClient({ mode: 'proxy' });
        const result = await proxyClient.testConnection!();
        setTestResult({
          ok: result.ok,
          latencyMs: result.latencyMs,
          message: result.message ?? (result.ok ? '站点默认服务连接正常' : '站点默认服务不可用'),
        });
        return;
      }

      const normalized = normalizeBaseUrl(baseUrl);
      if (!isAllowedBaseUrl(normalized, providerId)) {
        setError(
          providerId === 'local-gateway'
            ? '请填写有效的 http:// 或 https:// 网关地址。'
            : '请使用 HTTPS 地址（本地/内网 HTTP 地址请选「本地 / 内网网关」）。',
        );
        return;
      }
      const optional = isApiKeyOptional(normalized, providerId);
      if (!model.trim() || (!optional && !apiKey.trim())) {
        setError(optional ? '请先填写或获取模型名称。' : '请先填写模型名称和 API Key。');
        return;
      }

      const client = createLLMClient({
        mode: 'byok',
        providerId,
        baseUrl: normalized,
        apiKey: apiKey.trim(),
        model: model.trim(),
        useLocalProxy: localDevAvailable ? useLocalProxy : false,
      });
      const result = await client.testConnection!({ model: model.trim() });
      setTestResult({
        ok: result.ok,
        latencyMs: result.latencyMs,
        message: result.ok
          ? `连接成功（${result.model} · ${result.latencyMs} ms）`
          : result.message ?? '连接测试未通过',
      });
    } finally {
      setTesting(false);
    }
  }

  function handleSave(event: FormEvent) {
    event.preventDefault();
    if (section === 'appearance') {
      dialog.current?.close();
      return;
    }

    let next: ByokConfig | null = null;
    if (isCustomProvider) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!isAllowedBaseUrl(normalized, providerId)) {
        setError(
          providerId === 'local-gateway'
            ? '请填写有效的 http:// 或 https:// 网关地址，且不要包含 URL 凭据或查询参数。'
            : '请使用 HTTPS 地址（本机或局域网 HTTP 网关请选「本地 / 内网网关」），且不要包含查询参数。',
        );
        return;
      }
      const optional = isApiKeyOptional(normalized, providerId);
      if (!model.trim() || (!optional && !apiKey.trim())) {
        setError(optional ? '请填写或获取模型名称。' : '请填写模型名称和 API Key。');
        return;
      }
      const ensuredModels = fetchedModels.some((m) => m.id === model.trim())
        ? fetchedModels
        : [{ id: model.trim() }, ...fetchedModels];
      next = {
        providerId,
        baseUrl: normalized,
        model: model.trim(),
        apiKey: apiKey.trim(),
        cachedModels: ensuredModels.slice(0, 80),
        useLocalProxy: localDevAvailable ? useLocalProxy : false,
      };
    }

    try {
      saveByokConfig(next);
      onSaveApi(next);
      dialog.current?.close();
    } catch {
      setError('浏览器未允许保存设置，请检查本地存储权限后重试。');
    }
  }

  function updateThemeMode(mode: ThemeMode) {
    onThemeChange({ ...theme, mode });
  }

  function updateAccent(accentId: AccentPresetId, customHex?: string) {
    onThemeChange({
      ...theme,
      accentId,
      customAccent: customHex ?? theme.customAccent,
    });
  }

  function updatePrefs(patch: Partial<AppPreferences>) {
    const next = { ...prefs, ...patch };
    saveAppPreferences(next);
    onPrefsChange(next);
  }

  const modelChoices = fetchedModels.length > 0
    ? fetchedModels
    : getSuggestedModelOptions(providerId, model);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="settings-modal-title"
      className="settings-dialog"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="dialog-heading">
        <div className="dialog-title-group">
          <SlidersHorizontal size={18} />
          <h2 id="settings-modal-title">工作台设置</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭设置"
          onClick={() => dialog.current?.close()}
        >
          <X size={18} />
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-sidebar" aria-label="设置分组">
          <button
            type="button"
            className={section === 'api' ? 'active' : undefined}
            onClick={() => setSection('api')}
          >
            <Cpu size={15} />
            <span>模型与 API</span>
          </button>
          <button
            type="button"
            className={section === 'appearance' ? 'active' : undefined}
            onClick={() => setSection('appearance')}
          >
            <Palette size={15} />
            <span>外观与主题</span>
          </button>
        </nav>

        <form onSubmit={handleSave} className="settings-content">
          {section === 'api' ? (
            <div className="settings-pane">
              <div className="setting-block">
                <div className="setting-block-head">
                  <label className="setting-label">选择模型服务商</label>
                  {activePreset?.docsUrl && (
                    <a
                      className="text-link"
                      href={activePreset.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      获取 Key <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                <div className="provider-grid" role="radiogroup" aria-label="模型服务商预设">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={providerId === 'site-default'}
                    className={`provider-chip${providerId === 'site-default' ? ' selected' : ''}`}
                    onClick={() => selectProvider('site-default')}
                  >
                    <span>站点默认</span>
                  </button>
                  {PROVIDER_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="radio"
                      aria-checked={providerId === preset.id}
                      className={`provider-chip${providerId === preset.id ? ' selected' : ''}`}
                      onClick={() => selectProvider(preset.id)}
                    >
                      <span>{preset.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {isCustomProvider ? (
                <>
                  <div className="setting-block">
                    <label className="setting-field">
                      <span>API Base URL</span>
                      <input
                        type="url"
                        value={baseUrl}
                        onChange={(event) => {
                          setBaseUrl(event.target.value);
                          setTestResult(null);
                        }}
                        placeholder={
                          providerId === 'local-gateway'
                            ? 'http://127.0.0.1:11434/v1 或 http://192.168.x.x:8000/v1'
                            : 'https://api.deepseek.com/v1'
                        }
                        required
                      />
                    </label>
                    {providerId === 'local-gateway' && (
                      <p className="field-help">
                        支持 OpenAI 兼容的本地或内网网关（Ollama、LM Studio、vLLM、OneAPI / NewAPI、自建转发网关等），可直接填写 http:// 本机或局域网 IP。
                      </p>
                    )}
                  </div>

                  <div className="setting-block">
                    <label className="setting-field" htmlFor="settings-api-key">
                      <span>{keyOptional ? 'API Key（本地/内网网关可选）' : 'API Key'}</span>
                      <div className="key-field">
                        <input
                          id="settings-api-key"
                          type={showKey ? 'text' : 'password'}
                          value={apiKey}
                          onChange={(event) => {
                            setApiKey(event.target.value);
                            setTestResult(null);
                          }}
                          placeholder={keyOptional ? '无需鉴权可留空，需要则填写 sk-...' : 'sk-...'}
                          autoComplete="off"
                          spellCheck={false}
                          required={!keyOptional}
                        />
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                          onClick={() => setShowKey((visible) => !visible)}
                        >
                          {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </label>
                    <p className="field-help">
                      {keyOptional
                        ? '若网关免鉴权可直接留空；填写后仅保存在当前浏览器本地存储中。'
                        : 'Key 仅保存在你当前浏览器的本地存储中，生成电路时直连所选服务商。'}
                    </p>
                  </div>

                  {localDevAvailable && (providerId === 'local-gateway' || providerId === 'custom' || isLocalOrPrivateBaseUrl(baseUrl)) && (
                    <div className="setting-row-card">
                      <div className="setting-row-copy">
                        <span className="setting-row-title">
                          <Wifi size={14} /> 通过本地开发代理转发（解决内网 CORS 跨域）
                        </span>
                        <span className="field-help">
                          由当前本机开发服务器代发至目标网关，内网 API 未配置 CORS 响应头也能直接拉取模型并调用
                        </span>
                      </div>
                      <label className="switch-toggle">
                        <input
                          type="checkbox"
                          checked={useLocalProxy}
                          onChange={(event) => {
                            setUseLocalProxy(event.target.checked);
                            setTestResult(null);
                          }}
                        />
                        <span className="switch-track" />
                      </label>
                    </div>
                  )}

                  <div className="setting-block">
                    <div className="setting-block-head">
                      <label className="setting-label" htmlFor="settings-model-select">
                        默认对话模型
                      </label>
                      <div className="inline-actions">
                        <button
                          type="button"
                          className="mini-action-btn"
                          onClick={() => setCustomModelInput((value) => !value)}
                        >
                          {customModelInput ? '从列表选' : '手动填写'}
                        </button>
                        <button
                          type="button"
                          className="mini-action-btn"
                          disabled={modelsLoading}
                          onClick={() => void refreshModels()}
                        >
                          <RefreshCw size={12} className={modelsLoading ? 'spin' : undefined} />
                          {modelsLoading ? '获取中…' : '自动获取模型'}
                        </button>
                      </div>
                    </div>

                    {customModelInput || modelChoices.length === 0 ? (
                      <input
                        id="settings-model-select"
                        className="text-input"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="例如 deepseek-chat / glm-4.5-air / qwen-plus"
                        autoComplete="off"
                        required
                      />
                    ) : (
                      <CustomModelSelect
                        id="settings-model-select"
                        ariaLabel="默认对话模型"
                        variant="field"
                        options={modelChoices}
                        value={modelChoices.some((m) => m.id === model) ? model : modelChoices[0].id}
                        onChange={(nextModel) => setModel(nextModel)}
                      />
                    )}
                    {modelsHint && <p className="field-help">{modelsHint}</p>}
                  </div>
                </>
              ) : (
                <div className="info-card">
                  <p className="info-card-title">
                    站点默认代理{remainingQuota !== undefined ? ` · 今日剩余 ${remainingQuota} 次` : ''}
                  </p>
                  <p className="field-help">
                    无需填写密钥即可体验自由输入与多轮修改。若需更高并发或切换 DeepSeek、GLM、通义千问等特定模型，请在上方选择对应服务商。保存此选项会清除本地自定义 Key。
                  </p>
                </div>
              )}

              <div className="setting-row-card">
                <div className="setting-row-copy">
                  <span className="setting-row-title">
                    <Globe size={14} /> 允许联网查阅 Verilog 规范
                  </span>
                  <span className="field-help">
                    遇到复杂协议或修复受阻时自动搜索参考语法并在对话中附来源链接
                  </span>
                </div>
                <label className="switch-toggle">
                  <input
                    type="checkbox"
                    checked={prefs.enableWebResearch}
                    onChange={(event) => updatePrefs({ enableWebResearch: event.target.checked })}
                  />
                  <span className="switch-track" />
                </label>
              </div>

              <div className="connection-row">
                <button
                  type="button"
                  className="outline-button"
                  disabled={testing}
                  onClick={() => void runConnectionTest()}
                >
                  {testing ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}
                  {testing ? '测连中…' : '测试连接'}
                </button>
                {testResult && (
                  <span className={`test-pill ${testResult.ok ? 'ok' : 'fail'}`}>
                    {testResult.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    {testResult.message}
                  </span>
                )}
              </div>

              {error && (
                <p className="settings-error" role="alert">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="settings-pane">
              <div className="setting-block">
                <span className="setting-label">外观模式</span>
                <div className="theme-mode-grid" role="radiogroup" aria-label="深色与浅色模式">
                  {(
                    [
                      { id: 'light', label: '浅色模式', Icon: Sun },
                      { id: 'dark', label: '深色模式', Icon: Moon },
                      { id: 'system', label: '跟随系统', Icon: Monitor },
                    ] as const
                  ).map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={theme.mode === id}
                      className={`mode-card${theme.mode === id ? ' selected' : ''}`}
                      onClick={() => updateThemeMode(id)}
                    >
                      <span className="mode-card-icon">
                        <Icon size={17} />
                      </span>
                      <strong>{label}</strong>
                    </button>
                  ))}
                </div>
              </div>

              <div className="setting-block">
                <span className="setting-label">主题强调色</span>
                <div className="accent-grid" role="radiogroup" aria-label="主题色选择">
                  {ACCENT_PRESETS.map((preset) => {
                    const selected = theme.accentId === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`accent-option${selected ? ' selected' : ''}`}
                        onClick={() => updateAccent(preset.id)}
                      >
                        <span className="accent-swatch" style={{ background: preset.swatch }}>
                          {selected && (
                            <Check
                              size={13}
                              color={contrastInkOn(preset.swatch)}
                              strokeWidth={3}
                            />
                          )}
                        </span>
                        <span>{preset.name}</span>
                      </button>
                    );
                  })}

                  <label
                    className={`accent-option accent-custom${theme.accentId === 'custom' ? ' selected' : ''}`}
                    title="自定义任意主题色"
                  >
                    <input
                      type="color"
                      aria-label="自定义主题色"
                      value={theme.customAccent}
                      onChange={(event) => updateAccent('custom', event.target.value)}
                    />
                    <span className="accent-swatch" style={{ background: theme.customAccent }}>
                      {theme.accentId === 'custom' && (
                        <Check size={13} color={contrastInkOn(theme.customAccent)} strokeWidth={3} />
                      )}
                    </span>
                    <span>自定义</span>
                  </label>
                </div>
              </div>

              <div className="setting-block">
                <span className="setting-label">默认仿真时钟倍速</span>
                <div className="segmented-inline" role="radiogroup" aria-label="默认仿真时钟倍速">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={prefs.defaultClockSpeed === 'realtime'}
                    className={prefs.defaultClockSpeed === 'realtime' ? 'active' : undefined}
                    onClick={() => updatePrefs({ defaultClockSpeed: 'realtime' })}
                  >
                    实时（500ms/拍）
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={prefs.defaultClockSpeed === 'slow'}
                    className={prefs.defaultClockSpeed === 'slow' ? 'active' : undefined}
                    onClick={() => updatePrefs({ defaultClockSpeed: 'slow' })}
                  >
                    慢动作（0.2× 观察信号流）
                  </button>
                </div>
              </div>
            </div>
          )}

          <footer className="dialog-actions">
            {section === 'api' ? (
              <>
                <button type="button" className="outline-button" onClick={() => dialog.current?.close()}>
                  取消
                </button>
                <button type="submit" className="primary-button">
                  保存 API 配置
                </button>
              </>
            ) : (
              <button type="button" className="primary-button" onClick={() => dialog.current?.close()}>
                完成（已即时生效）
              </button>
            )}
          </footer>
        </form>
      </div>
    </dialog>
  );
}
