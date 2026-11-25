import {
  CircuitBoard,
  History,
  LayoutGrid,
  MessageSquare,
  Moon,
  Plus,
  SlidersHorizontal,
  Stethoscope,
  Sun,
} from 'lucide-react';

export type RailTab = 'chat' | 'presets' | 'clinic' | 'history';

const NAV_ITEMS: Array<{ id: RailTab; label: string; Icon: typeof MessageSquare }> = [
  { id: 'chat', label: '对话', Icon: MessageSquare },
  { id: 'presets', label: '案例', Icon: LayoutGrid },
  { id: 'clinic', label: '诊所', Icon: Stethoscope },
  { id: 'history', label: '历史', Icon: History },
];

export function NavRail({
  activeTab,
  onSelectTab,
  onGoHome,
  onNewChat,
  onOpenSettings,
  resolvedTheme,
  onToggleTheme,
  hasCustomApi,
  hasActiveBug,
}: {
  activeTab: RailTab;
  onSelectTab: (tab: RailTab) => void;
  onGoHome: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  resolvedTheme: 'light' | 'dark';
  onToggleTheme: () => void;
  hasCustomApi: boolean;
  hasActiveBug?: boolean;
}) {
  return (
    <aside className="nav-rail" aria-label="主导航">
      <button
        type="button"
        className="rail-brand"
        title="FPGAgent · 返回首页"
        aria-label="FPGAgent 返回首页"
        onClick={onGoHome}
      >
        <CircuitBoard size={19} strokeWidth={2.1} />
      </button>

      <button
        type="button"
        className="rail-new"
        title="新建对话"
        aria-label="新建对话"
        onClick={onNewChat}
      >
        <Plus size={17} />
      </button>

      <div className="rail-divider" aria-hidden="true" />

      <nav className="rail-nav" aria-label="功能分区">
        {NAV_ITEMS.map(({ id, label, Icon }) => {
          const selected = activeTab === id;
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
                {id === 'clinic' && hasActiveBug && <span className="rail-badge-dot warn" />}
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <button
          type="button"
          className="rail-item"
          title={resolvedTheme === 'dark' ? '切换浅色模式' : '切换深色模式'}
          aria-label={resolvedTheme === 'dark' ? '切换浅色模式' : '切换深色模式'}
          onClick={onToggleTheme}
        >
          {resolvedTheme === 'dark' ? <Sun size={17} strokeWidth={1.8} /> : <Moon size={17} strokeWidth={1.8} />}
          <span>{resolvedTheme === 'dark' ? '浅色' : '深色'}</span>
        </button>

        <button
          type="button"
          className="rail-item"
          title="外观与 API 设置"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          <span className="rail-icon-wrap">
            <SlidersHorizontal size={17} strokeWidth={1.8} />
            {hasCustomApi && <span className="rail-badge-dot" title="已配置自定义 API" />}
          </span>
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
