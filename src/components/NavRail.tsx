import {
  CircuitBoard,
  Cpu,
  History,
  Languages,
  LayoutGrid,
  MessageSquare,
  Moon,
  Plus,
  SlidersHorizontal,
  Sun,
} from 'lucide-react';
import { useI18n } from '../services/i18n';

export type RailTab = 'chat' | 'board' | 'presets' | 'history';

const NAV_ITEMS: Array<{ id: RailTab; zh: string; en: string; Icon: typeof MessageSquare }> = [
  { id: 'chat', zh: '对话', en: 'Chat', Icon: MessageSquare },
  { id: 'board', zh: '板卡', en: 'Board', Icon: Cpu },
  { id: 'presets', zh: '案例', en: 'Demos', Icon: LayoutGrid },
  { id: 'history', zh: '历史', en: 'History', Icon: History },
];

export function NavRail({
  activeTab,
  isShowcase = false,
  onSelectTab,
  onOpenShowcase,
  onNewChat,
  onOpenSettings,
  resolvedTheme,
  onToggleTheme,
  hasCustomApi,
}: {
  activeTab: RailTab;
  isShowcase?: boolean;
  onSelectTab: (tab: RailTab) => void;
  onOpenShowcase: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  resolvedTheme: 'light' | 'dark';
  onToggleTheme: () => void;
  hasCustomApi: boolean;
}) {
  const { locale, toggleLocale, L } = useI18n();

  return (
    <aside className="nav-rail" aria-label={L('主导航', 'Primary navigation')}>
      <button
        type="button"
        className={`rail-brand${isShowcase ? ' active' : ''}`}
        title={L('FPGAgent · 产品介绍', 'FPGAgent · Overview')}
        aria-label={L('FPGAgent 产品介绍', 'FPGAgent Overview')}
        aria-current={isShowcase ? 'page' : undefined}
        onClick={onOpenShowcase}
      >
        <CircuitBoard size={19} strokeWidth={2.1} />
      </button>

      <button
        type="button"
        className="rail-new"
        title={L('新建对话', 'New chat')}
        aria-label={L('新建对话', 'New chat')}
        onClick={onNewChat}
      >
        <Plus size={17} />
      </button>

      <div className="rail-divider" aria-hidden="true" />

      <nav className="rail-nav" aria-label={L('功能分区', 'Sections')}>
        {NAV_ITEMS.map(({ id, zh, en, Icon }) => {
          const selected = !isShowcase && activeTab === id;
          return (
            <button
              key={id}
              type="button"
              className={`rail-item${selected ? ' selected' : ''}`}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelectTab(id)}
            >
              <span className="rail-icon-wrap">
                <Icon size={17} strokeWidth={selected ? 2.1 : 1.8} />
              </span>
              <span>{L(zh, en)}</span>
            </button>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <button
          type="button"
          className="rail-item"
          title={locale === 'zh' ? 'Switch to English' : '切换为中文'}
          aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}
          onClick={toggleLocale}
        >
          <Languages size={17} strokeWidth={1.8} />
          <span>{locale === 'zh' ? 'EN' : '中文'}</span>
        </button>

        <button
          type="button"
          className="rail-item"
          title={
            resolvedTheme === 'dark'
              ? L('切换浅色模式', 'Switch to light mode')
              : L('切换深色模式', 'Switch to dark mode')
          }
          aria-label={
            resolvedTheme === 'dark'
              ? L('切换浅色模式', 'Switch to light mode')
              : L('切换深色模式', 'Switch to dark mode')
          }
          onClick={onToggleTheme}
        >
          {resolvedTheme === 'dark' ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
          <span>{resolvedTheme === 'dark' ? L('浅色', 'Light') : L('深色', 'Dark')}</span>
        </button>

        <button
          type="button"
          className="rail-item"
          title={L('外观与 API 设置', 'Appearance & API Settings')}
          aria-label={L('打开设置', 'Open settings')}
          onClick={onOpenSettings}
        >
          <span className="rail-icon-wrap">
            <SlidersHorizontal size={17} strokeWidth={1.8} />
            {hasCustomApi && <span className="rail-badge-dot" title={L('已配置自定义 API', 'Custom API configured')} />}
          </span>
          <span>{L('设置', 'Settings')}</span>
        </button>
      </div>
    </aside>
  );
}
