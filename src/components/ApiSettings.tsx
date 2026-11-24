import { Eye, EyeOff, Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { saveByokConfig, type ByokConfig } from '../services/llmClient';

export function ApiSettings({ config, onSave, onClose }: {
  config: ByokConfig | null;
  onSave: (config: ByokConfig | null) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [custom, setCustom] = useState(Boolean(config));
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [model, setModel] = useState(config?.model ?? '');
  const [apiKey, setApiKey] = useState(config?.apiKey ?? '');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  function save(event: FormEvent) {
    event.preventDefault();
    let next: ByokConfig | null = null;
    if (custom) {
      let url: URL;
      try {
        url = new URL(baseUrl.trim());
      } catch {
        setError('请输入完整的 API Base URL。');
        return;
      }
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
      if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
        setError('请使用 HTTPS 地址。本机 localhost 可用 HTTP。地址中无需填写密钥或查询参数。');
        return;
      }
      if (!model.trim() || !apiKey.trim()) {
        setError('请填写模型名称和 API Key。');
        return;
      }
      next = {
        baseUrl: url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''),
        model: model.trim(),
        apiKey: apiKey.trim(),
      };
    }

    try {
      saveByokConfig(next);
      onSave(next);
      dialog.current?.close();
    } catch {
      setError('浏览器未允许保存设置，请检查站点存储权限后重试。');
    }
  }

  return (
    <dialog ref={dialog} aria-labelledby="api-settings-title" className="settings-dialog" onClose={onClose}>
      <div className="dialog-heading">
        <h2 id="api-settings-title"><Settings2 size={19} /> API 设置</h2>
        <button type="button" className="icon-button" aria-label="关闭 API 设置" onClick={() => dialog.current?.close()}><X size={19} /></button>
      </div>
      <form onSubmit={save} className="settings-form">
        <fieldset className="provider-modes">
          <legend>模型来源</legend>
          <label><input type="radio" name="api-mode" checked={!custom} onChange={() => { setCustom(false); setError(''); }} /> 站点默认</label>
          <label><input type="radio" name="api-mode" checked={custom} onChange={() => { setCustom(true); setError(''); }} /> 自定义 API</label>
        </fieldset>
        {custom ? (
          <div className="settings-fields">
            <label>API Base URL<input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" required /></label>
            <label>模型名称<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="例如 qwen-plus" autoComplete="off" required /></label>
            <label htmlFor="custom-api-key">API Key</label>
            <div className="key-field">
              <input id="custom-api-key" type={showKey ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} required />
              <button type="button" className="icon-button" aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} onClick={() => setShowKey((visible) => !visible)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            </div>
            <p className="field-help">使用支持浏览器调用的 OpenAI 兼容接口。Key 保存在当前浏览器，生成时直接发送给你配置的服务。</p>
          </div>
        ) : <p className="field-help">使用站点配置的模型服务。保存此选项会清除浏览器里的自定义 Key。</p>}
        {error && <p className="settings-error" role="alert">{error}</p>}
        <footer className="dialog-actions">
          <button type="button" className="outline-button" onClick={() => dialog.current?.close()}>取消</button>
          <button type="submit" className="primary-button">保存设置</button>
        </footer>
      </form>
    </dialog>
  );
}
