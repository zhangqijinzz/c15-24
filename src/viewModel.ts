import { cloneScenario, summarizeScenario, validateDevice, validateScenarioSettings } from './domain';
import { findScenario, type EnergyRepository } from './repository';
import type { DocumentConflict, EnergyDevice, EnergyDocument, EnergyScenario, Notice, ViewStatus } from './types';

export interface EnergyLensState {
  document: EnergyDocument | null;
  status: ViewStatus;
  notice: Notice | null;
  /** 与其他标签页的改动撞在一起时非空，等待用户选择保留哪一份 */
  conflict: DocumentConflict | null;
}

type Listener = (state: EnergyLensState) => void;

export class EnergyLensViewModel {
  private state: EnergyLensState = { document: null, status: 'loading', notice: null, conflict: null };
  private readonly listeners = new Set<Listener>();
  /** 最近一次与存储保持一致的文档；state.document 偏离它即说明本页有未落盘的改动 */
  private persisted: EnergyDocument | null = null;
  private unsubscribeExternal: (() => void) | null = null;

  constructor(private readonly repository: EnergyRepository) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): EnergyLensState { return this.state; }

  initialize(): void {
    try {
      const document = this.repository.load();
      this.persisted = document;
      this.state = { document, status: 'ready', notice: null, conflict: null };
    } catch {
      this.state = { document: null, status: 'error', notice: { kind: 'error', text: '本地数据读取失败，请刷新重试' }, conflict: null };
    }
    this.unsubscribeExternal?.();
    try {
      this.unsubscribeExternal = this.repository.onExternalChange((remote) => this.handleExternalChange(remote));
    } catch {
      // 环境不支持跨页监听时退化为单页体验
      this.unsubscribeExternal = null;
    }
    this.emit();
  }

  dispose(): void {
    this.unsubscribeExternal?.();
    this.unsubscribeExternal = null;
  }

  get activeScenario(): EnergyScenario | null {
    if (!this.state.document) return null;
    return findScenario(this.state.document, this.state.document.activeScenarioId) ?? null;
  }

  get activeSummary() {
    return this.activeScenario ? summarizeScenario(this.activeScenario) : null;
  }

  updateDevice(deviceId: string, patch: Partial<Pick<EnergyDevice, 'name' | 'watts' | 'dailyHours'>>): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const device = scenario.devices.find((item) => item.id === deviceId);
    if (!device) return;
    const next = { ...device, ...patch };
    const error = validateDevice(next);
    if (error) {
      this.setNotice({ kind: 'error', text: error });
      return;
    }
    this.commit((current) => ({ ...current, devices: current.devices.map((item) => item.id === deviceId ? next : item) }), '参数已更新');
  }

  addDevice(): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const device: EnergyDevice = { id: `device-${Date.now()}`, name: '新设备', watts: 100, dailyHours: 1 };
    this.commit((current) => ({ ...current, devices: [...current.devices, device] }), '已添加设备，可继续修改参数');
  }

  removeDevice(deviceId: string): void {
    const scenario = this.activeScenario;
    if (!scenario || scenario.devices.length <= 1) {
      this.setNotice({ kind: 'info', text: '至少保留一个设备，便于计算方案' });
      return;
    }
    this.commit((current) => ({ ...current, devices: current.devices.filter((item) => item.id !== deviceId) }), '设备已移除');
  }

  updateSettings(patch: Partial<Pick<EnergyScenario, 'name' | 'pricePerKwh' | 'daysPerMonth'>>): void {
    const scenario = this.activeScenario;
    if (!scenario) return;
    const next = { ...scenario, ...patch };
    const error = validateScenarioSettings(next.pricePerKwh, next.daysPerMonth);
    if (error) {
      this.setNotice({ kind: 'error', text: error });
      return;
    }
    this.commit((current) => ({ ...current, name: next.name.trim() || '未命名方案', pricePerKwh: next.pricePerKwh, daysPerMonth: next.daysPerMonth }), '计费参数已更新');
  }

  duplicateActive(): void {
    const source = this.activeScenario;
    if (!source || !this.state.document) return;
    const id = `scenario-${Date.now()}`;
    const copy = cloneScenario(source, id, `${source.name} · 副本`);
    const document = { ...this.state.document, scenarios: [...this.state.document.scenarios, copy], activeScenarioId: id };
    this.persist(document, '方案已复制，现在可以修改副本');
  }

  selectScenario(id: string): void {
    if (!this.state.document || !findScenario(this.state.document, id)) return;
    this.persist({ ...this.state.document, activeScenarioId: id }, '已切换方案');
  }

  complete(): void {
    this.state = { ...this.state, status: 'completed', notice: { kind: 'success', text: '本次推演已保存，可随时回来继续调整' } };
    this.emit();
  }

  /** 冲突待解决时由用户选择：保留本页改动，或采用另一标签页的内容 */
  resolveConflict(choice: 'local' | 'remote'): void {
    const conflict = this.state.conflict;
    if (!conflict || !this.state.document) return;
    if (choice === 'remote') {
      this.persisted = conflict.remote;
      this.state = { ...this.state, document: conflict.remote, status: 'editing', notice: { kind: 'info', text: '已改用其他标签页的内容，本页未保存的改动已放弃' }, conflict: null };
      this.emit();
      return;
    }
    try {
      const outcome = this.repository.overwrite(this.state.document);
      if (outcome.status === 'conflict') {
        this.state = { ...this.state, conflict: { remote: outcome.current }, notice: { kind: 'error', text: '另一标签页刚又写入了新内容，请重新选择' } };
      } else {
        this.persisted = this.state.document;
        this.state = { ...this.state, status: 'editing', notice: { kind: 'success', text: '已保留本页改动，其他标签页将自动同步' }, conflict: null };
      }
    } catch {
      this.state = { ...this.state, status: 'error', notice: { kind: 'error', text: '保存失败，当前页面仍可继续编辑' } };
    }
    this.emit();
  }

  private get hasUnsavedChanges(): boolean {
    return this.state.document !== null && this.state.document !== this.persisted;
  }

  private handleExternalChange(remote: EnergyDocument): void {
    if (this.state.conflict) {
      // 冲突待解决期间：只刷新"另一份"的内容，不打扰本页编辑
      this.state = { ...this.state, conflict: { remote } };
      this.emit();
      return;
    }
    if (this.hasUnsavedChanges) {
      // 本页还有没落盘的改动：不能静默覆盖，交给用户选择
      this.state = { ...this.state, conflict: { remote } };
      this.emit();
      return;
    }
    // 本页没有未保存改动：直接跟上最新数据，避免停在旧版本上继续写
    this.persisted = remote;
    this.state = {
      ...this.state,
      document: remote,
      status: this.state.document ? this.state.status : 'ready',
      notice: { kind: 'info', text: '检测到其他标签页的改动，已为你同步' },
    };
    this.emit();
  }

  private commit(update: (scenario: EnergyScenario) => EnergyScenario, notice: string): void {
    if (!this.state.document) return;
    const document = { ...this.state.document, scenarios: this.state.document.scenarios.map((scenario) => scenario.id === this.state.document?.activeScenarioId ? update(scenario) : scenario) };
    this.persist(document, notice);
  }

  private persist(document: EnergyDocument, notice: string): void {
    if (this.state.conflict) {
      // 冲突未解决前不再写存储，避免反复覆盖或连环冲突提示；改动先留在本页内存中
      this.state = { ...this.state, document, status: 'editing' };
      this.emit();
      return;
    }
    try {
      const outcome = this.repository.save(document);
      if (outcome.status === 'conflict') {
        // 别处已改过：保留本页改动，交给用户选择，绝不直接覆盖
        this.state = { ...this.state, document, status: 'editing', notice: null, conflict: { remote: outcome.current } };
      } else {
        this.persisted = document;
        this.state = { document, status: 'editing', notice: { kind: 'success', text: notice }, conflict: null };
      }
    } catch {
      this.state = { ...this.state, document, status: 'error', notice: { kind: 'error', text: '保存失败，当前页面仍可继续编辑' } };
    }
    this.emit();
  }

  private setNotice(notice: Notice): void {
    this.state = { ...this.state, status: notice.kind === 'error' ? 'error' : 'editing', notice };
    this.emit();
  }

  private emit(): void { this.listeners.forEach((listener) => listener(this.state)); }
}
