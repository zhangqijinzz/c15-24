import { formatNumber } from '../domain';
import type { EnergyScenario } from '../types';

interface ScenarioCardProps { scenario: EnergyScenario; totalKwh: number; active: boolean; onSelect: () => void; }

export function ScenarioCard({ scenario, totalKwh, active, onSelect }: ScenarioCardProps) {
  return <button className={`scenario-card ${active ? 'active' : ''}`} onClick={onSelect}>
    <span className="scenario-dot" />
    <span className="scenario-copy"><strong>{scenario.name}</strong><small>{scenario.devices.length} 台设备 · {formatNumber(totalKwh)} kWh / 月</small></span>
    <span className="arrow">→</span>
  </button>;
}
