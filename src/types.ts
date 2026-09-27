export interface EnergyDevice {
  id: string;
  name: string;
  watts: number;
  dailyHours: number;
}

export interface EnergyScenario {
  id: string;
  name: string;
  pricePerKwh: number;
  daysPerMonth: number;
  devices: EnergyDevice[];
  createdAt: string;
}

export interface EnergyDocument {
  version: 1;
  scenarios: EnergyScenario[];
  activeScenarioId: string;
}

export type ViewStatus = 'loading' | 'ready' | 'editing' | 'error' | 'completed' | 'conflict';

export interface Notice {
  kind: 'success' | 'error' | 'info';
  text: string;
}

/**
 * 另一个标签页已经先写入时，本页暂存的待决冲突。
 * base 为本页尚未落盘的版本，remote 为存储中检测到的新版本（可能为 null，如数据被清空）。
 */
export interface PendingConflict {
  base: EnergyDocument;
  baseRevision: number;
  remote: EnergyDocument | null;
  remoteRevision: number;
}

export interface EnergyEstimate {
  dailyKwh: number;
  monthlyKwh: number;
  monthlyCost: number;
}

export interface ScenarioSummary {
  total: EnergyEstimate;
  devices: Array<EnergyDevice & EnergyEstimate & { share: number }>;
}
