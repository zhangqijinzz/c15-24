// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalEnergyRepository } from '../repository';
import { readEnvelope } from '../services/storageService';
import { EnergyLensViewModel } from '../viewModel';

const STORAGE_KEY = 'energy-lens.document.v1';

/** 模拟浏览器把存储变化广播给其他标签页（jsdom 不会自动派发 storage 事件） */
function notifyOtherTabs() {
  window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
}

function openTab() {
  const vm = new EnergyLensViewModel(new LocalEnergyRepository());
  vm.initialize();
  return vm;
}

describe('two tabs sharing localStorage', () => {
  beforeEach(() => localStorage.clear());

  it('keeps both tabs in sync as edits flow through storage', () => {
    const tabA = openTab();
    const tabB = openTab();
    tabA.updateDevice('device-aircon', { dailyHours: 2 });
    notifyOtherTabs();
    // B 没有未保存改动：自动跟上 A 的版本，而不是停在旧数据上
    expect(tabB.activeScenario?.devices[0].dailyHours).toBe(2);
    expect(tabB.getState().conflict).toBeNull();
    // B 在最新数据上继续编辑，保存不再冲突
    tabB.updateDevice('device-fridge', { watts: 200 });
    expect(tabB.getState().conflict).toBeNull();
    notifyOtherTabs();
    expect(tabA.activeScenario?.devices[1].watts).toBe(200);
  });

  it('detects a genuine conflict, never overwrites silently, and converges after the user chooses', () => {
    const tabA = openTab();
    const tabB = openTab();
    tabA.updateDevice('device-aircon', { dailyHours: 2 });
    // B 尚未收到通知就也改了同一台设备 → 保存时发现 A 已写过
    tabB.updateDevice('device-aircon', { dailyHours: 8 });
    expect(tabB.getState().conflict).not.toBeNull();
    // 存储里仍是 A 的完整版本，没有被 B 悄悄覆盖
    expect(readEnvelope()?.document.scenarios[0].devices[0].dailyHours).toBe(2);
    // B 选择保留本页 → 强制写入
    tabB.resolveConflict('local');
    expect(tabB.getState().conflict).toBeNull();
    expect(readEnvelope()?.document.scenarios[0].devices[0].dailyHours).toBe(8);
    // A 收到通知后跟上，两个标签页收敛到同一份数据
    notifyOtherTabs();
    expect(tabA.activeScenario?.devices[0].dailyHours).toBe(8);
    expect(tabA.getState().conflict).toBeNull();
  });

  it('adopting the remote version drops local edits and keeps later saves conflict-free', () => {
    const tabA = openTab();
    const tabB = openTab();
    tabA.updateDevice('device-aircon', { dailyHours: 2 });
    tabB.updateDevice('device-aircon', { dailyHours: 8 });
    expect(tabB.getState().conflict).not.toBeNull();
    // B 选择采用另一标签页的内容 → 本地改动被放弃
    tabB.resolveConflict('remote');
    expect(tabB.activeScenario?.devices[0].dailyHours).toBe(2);
    expect(tabB.getState().conflict).toBeNull();
    // B 之后继续编辑，基于已同步的最新版本，不会再误判冲突
    tabB.updateDevice('device-aircon', { dailyHours: 5 });
    expect(tabB.getState().conflict).toBeNull();
    expect(readEnvelope()?.document.scenarios[0].devices[0].dailyHours).toBe(5);
  });
});
