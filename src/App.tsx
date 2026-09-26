import { DeviceEditor } from './components/DeviceEditor';
import { ScenarioCard } from './components/ScenarioCard';
import { formatNumber } from './domain';
import { useEnergyLens } from './hooks';

function App() {
  const { vm, state } = useEnergyLens();
  const active = vm.activeScenario;
  const summary = vm.activeSummary;
  if (state.status === 'loading' || !active || !summary) return <main className="loading-screen"><div className="pulse" /><p>正在恢复你的能耗方案…</p></main>;
  const maxKwh = Math.max(...summary.devices.map((device) => device.monthlyKwh), 1);
  const baseline = state.document?.scenarios.find((item) => item.id !== active.id);
  const comparisonValue = baseline && baseline.id !== active.id ? baseline.devices.reduce((total, device) => total + (device.watts * device.dailyHours * baseline.daysPerMonth) / 1000, 0) : null;
  const deltaKwh = comparisonValue === null ? null : summary.total.monthlyKwh - comparisonValue;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">⌁</span><span>Energy<span>Lens</span></span></div>
      <div className="topbar-right"><span className="save-state"><i /> {state.status === 'error' ? '需要注意' : '已自动保存'}</span><button className="help-button" aria-label="帮助">?</button></div>
    </header>

    <main className="page-wrap">
      <section className="hero">
        <div><p className="eyebrow">家庭能耗推演器 <span>·</span> 轻量决策工具</p><h1>让每一度电<br /><span>都看得见。</span></h1><p className="hero-copy">把设备、使用习惯和电价放进来，马上看见<br className="desktop-only" />它们如何影响你的月度账单。</p></div>
        <div className="hero-spark"><span>本月预计用电</span><strong>{formatNumber(summary.total.monthlyKwh)} <small>kWh</small></strong><div className="sparkline"><i /><i /><i /><i /><i /><i /><i /></div></div>
      </section>

      {state.notice && <div className={`notice ${state.notice.kind}`} role="status"><span>{state.notice.kind === 'error' ? '!' : '✓'}</span>{state.notice.text}</div>}

      <div className="workspace-grid">
        <section className="panel setup-panel">
          <div className="panel-heading"><div><span className="step">01</span><h2>设备配置</h2><p>输入设备的额定功率与每天使用时长</p></div><span className="count-pill">{active.devices.length} 台设备</span></div>
          <div className="device-list">{active.devices.map((device) => <DeviceEditor key={device.id} device={device} onChange={(patch) => vm.updateDevice(device.id, patch)} onRemove={() => vm.removeDevice(device.id)} />)}</div>
          <button className="add-device" onClick={() => vm.addDevice()}><span>＋</span> 添加一台设备</button>
          <div className="tip"><span>✦</span><p><strong>小提示</strong> 功率可以在设备铭牌或说明书上找到，1,000 W = 1 kW。</p></div>
        </section>

        <section className="panel settings-panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>时间与价格</h2><p>调整计费周期，让估算更贴近你的账单</p></div></div>
          <label className="big-field"><span>每月计费天数 <em>天</em></span><input type="number" min="1" max="31" value={active.daysPerMonth} onChange={(event) => vm.updateSettings({ daysPerMonth: Number(event.target.value) })} /></label>
          <label className="big-field"><span>居民电价 <em>元 / kWh</em></span><div className="input-prefix"><b>¥</b><input type="number" min="0" step="0.01" value={active.pricePerKwh} onChange={(event) => vm.updateSettings({ pricePerKwh: Number(event.target.value) })} /></div></label>
          <div className="formula"><span>计算方式</span><code>功率(W) × 时长(h) ÷ 1,000 × 天数</code><small>结果为估算值，实际账单可能受阶梯电价影响。</small></div>
        </section>
      </div>

      <section className="results-section"><div className="section-title"><div><span className="step">03</span><h2>结果分析</h2><p>你的用电结构，一眼看清</p></div><div className="result-actions"><span className="updated">实时更新 · {state.status === 'completed' ? '已完成' : '编辑中'}</span><button className="primary-button" onClick={() => vm.complete()}>完成本次推演 <span>→</span></button></div></div>
        <div className="metrics"><div className="metric-card featured"><span>月度预计用电</span><strong>{formatNumber(summary.total.monthlyKwh)} <small>kWh</small></strong><em>约 ¥{formatNumber(summary.total.monthlyCost)} / 月</em></div><div className="metric-card"><span>日均用电</span><strong>{formatNumber(summary.total.dailyKwh)} <small>kWh</small></strong><em>平均每天</em></div><div className="metric-card"><span>设备数量</span><strong>{active.devices.length} <small>台</small></strong><em>已纳入估算</em></div></div>
        <div className="analysis-grid"><div className="chart-card"><div className="card-heading"><div><h3>设备消耗占比</h3><p>按月度用电量排序</p></div><span className="legend"><i /> 月度 kWh</span></div><div className="bar-chart">{summary.devices.slice().sort((a, b) => b.monthlyKwh - a.monthlyKwh).map((device) => <div className="bar-row" key={device.id}><div className="bar-label"><span>{device.name}</span><b>{formatNumber(device.monthlyKwh)} kWh</b></div><div className="bar-track"><i style={{ width: `${(device.monthlyKwh / maxKwh) * 100}%` }} /><span>{Math.round(device.share * 100)}%</span></div></div>)}</div></div><div className="insight-card"><span className="insight-icon">◒</span><h3>你的最大用电来源</h3><strong>{summary.devices.slice().sort((a, b) => b.monthlyKwh - a.monthlyKwh)[0]?.name}</strong><p>占总用电的 <b>{Math.round((summary.devices.slice().sort((a, b) => b.monthlyKwh - a.monthlyKwh)[0]?.share ?? 0) * 100)}%</b>。每天减少 1 小时使用，预计每月可节省 <b>¥{formatNumber((summary.devices.slice().sort((a, b) => b.monthlyKwh - a.monthlyKwh)[0]?.watts ?? 0) / 1000 * active.pricePerKwh * 30)}</b>。</p></div></div>
      </section>

      <section className="scenario-section"><div className="section-title"><div><span className="step">04</span><h2>方案对比</h2><p>复制当前方案，试试另一种生活方式</p></div><button className="secondary-button" onClick={() => vm.duplicateActive()}>＋ 复制当前方案</button></div><div className="scenario-grid">{state.document?.scenarios.map((scenario) => <ScenarioCard key={scenario.id} scenario={scenario} totalKwh={scenario.id === active.id ? summary.total.monthlyKwh : scenario.devices.reduce((sum, device) => sum + (device.watts * device.dailyHours * scenario.daysPerMonth) / 1000, 0)} active={scenario.id === active.id} onSelect={() => vm.selectScenario(scenario.id)} />)}</div>{baseline && deltaKwh !== null && <div className="comparison-note"><span>↕</span><p>当前方案相较于“{baseline.name}”每月 <b>{deltaKwh <= 0 ? '少' : '多'} {formatNumber(Math.abs(deltaKwh))} kWh</b>，电费约 <b>¥{formatNumber(Math.abs(deltaKwh) * active.pricePerKwh)}</b>。</p></div>}</section>
    </main>
    <footer><span>EnergyLens · 用数据做出更好的能源选择</span><span>本地保存 · 数据只属于你</span></footer>
  </div>;
}

export default App;
