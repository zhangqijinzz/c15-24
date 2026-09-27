import { cloneScenario, summarizeScenario, validateDevice, validateScenarioSettings } from './domain';
import { DocumentConflictError, findScenario, type EnergyRepository } from './repository';
import type { EnergyDevice, EnergyDocument, EnergyScenario, Notice, PendingConflict, ViewStatus } from './types';

export interface EnergyLensState {
  document: EnergyDocument | null;
  status: ViewStatus;
  notice: Notice | null;
  /** 本页当前持有文档的版本号，等于存储版本时保存可直接走快速路径。 */
  revision: number;
  /** 存在待决冲突时，主界面只读，必须由用户选择保留哪一份。 */
  conflict: PendingConflict | null;
}

type Listener = (state: EnergyLensState) => void;

export class EnergyLensViewModel {
  private state: EnergyLensState = { document: null, status: 'loading', notice: null, revision: 0, conflict: null };
  private readonly listeners = new Set<Listener>();
  private unsubscribeRepository: (() => void) | null = null;
  /** 本页是否持有尚未确认落盘的内容（例如上一次保存因配额失败后继续编辑）。 */
  private dirty = false;

  constructor(private readonly repository: EnergyRepository) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): EnergyLensState { return this.state; }

  initialize(): void {
    if (this.unsubscribeRepository) return;
    this.unsubscribeRepository = this.repository.subscribe((change) => this.handleRemoteChange(change));
    try {
      const { document, revision } = this.repository.load();
      this.dirty = false;
      this.state = { document, status: 'ready', notice: null, revision, conflict: null };
    } catch {
      this.state = { document: null, status: 'error', notice: { kind: 'error', text: '本地数据读取失败，请刷新重试' }, revision: 0, conflict: null };
    }
    this.emit();
  }

  dispose(): void {
    this.unsubscribeRepository?.();
    this.unsubscribeRepository = null;
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
    if (!scenario || this.state.conflict) return;
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
    if (!scenario || this.state.conflict) return;
    const device: EnergyDevice = { id: `device-${Date.now()}`, name: '新设备', watts: 100, dailyHours: 1 };
    this.commit((current) => ({ ...current, devices: [...current.devices, device] }), '已添加设备，可继续修改参数');
  }

  removeDevice(deviceId: string): void {
    const scenario = this.activeScenario;
    if (!scenario || this.state.conflict) return;
    if (scenario.devices.length <= 1) {
      this.setNotice({ kind: 'info', text: '至少保留一个设备，便于计算方案' });
      return;
    }
    this.commit((current) => ({ ...current, devices: current.devices.filter((item) => item.id !== deviceId) }), '设备已移除');
  }

  updateSettings(patch: Partial<Pick<EnergyScenario, 'name' | 'pricePerKwh' | 'daysPerMonth'>>): void {
    const scenario = this.activeScenario;
    if (!scenario || this.state.conflict) return;
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
    if (!source || !this.state.document || this.state.conflict) return;
    const id = `scenario-${Date.now()}`;
    const copy = cloneScenario(source, id, `${source.name} · 副本`);
    const document = { ...this.state.document, scenarios: [...this.state.document.scenarios, copy], activeScenarioId: id };
    this.persist(document, '方案已复制，现在可以修改副本');
  }

  selectScenario(id: string): void {
    if (!this.state.document || !findScenario(this.state.document, id) || this.state.conflict) return;
    this.persist({ ...this.state.document, activeScenarioId: id }, '已切换方案');
  }

  complete(): void {
    if (this.state.conflict) return;
    this.state = { ...this.state, status: 'completed', notice: { kind: 'success', text: '本次推演已保存，可随时回来继续调整' } };
    this.emit();
  }

  /**
   * 解决跨标签页冲突。
   * - 'remote'：放弃本页版本，采用其它标签页已写入的版本；
   * - 'local'：以本页版本强制写入，其它标签页随后通过广播静默跟进。
   */
  resolveConflict(choice: 'local' | 'remote'): void {
    const conflict = this.state.conflict;
    if (!conflict) return;

    if (choice === 'remote') {
      if (!conflict.remote) return; // 远端已被清空时不允许“采用远端”，界面上会禁用该选项
      this.dirty = false;
      this.state = {
        ...this.state,
        document: conflict.remote,
        revision: conflict.remoteRevision,
        status: 'ready',
        notice: { kind: 'info', text: '已切换为其它标签页中的版本' },
        conflict: null,
      };
      this.emit();
      return;
    }

    try {
      const { revision } = this.repository.forceSave(conflict.base, conflict.remoteRevision);
      this.dirty = false;
      this.state = {
        ...this.state,
        document: conflict.base,
        revision,
        status: 'editing',
        notice: { kind: 'success', text: '已保留本页版本，其它标签页将自动同步' },
        conflict: null,
      };
    } catch {
      // 强制写入仍失败（如存储配额）：保持冲突待决，本页内容不丢。
      this.state = { ...this.state, status: 'error', notice: { kind: 'error', text: '保存失败，请处理后重试，本页内容仍保留' } };
    }
    this.emit();
  }

  /** 冲突弹窗打开期间，远端继续被更新时，刷新“对方版本”的信息。 */
  private handleRemoteChange(change: { revision: number; document: EnergyDocument | null }): void {
    if (!this.state.document) return;
    if (change.revision <= this.state.revision) return; // 旧版本重放，忽略

    if (this.state.conflict) {
      this.state = {
        ...this.state,
        conflict: { ...this.state.conflict, remote: change.document, remoteRevision: change.revision },
      };
      this.emit();
      return;
    }

    if (this.dirty) {
      // 本页有未落盘改动：不能静默覆盖，交给用户决定保留哪一份。
      this.state = {
        ...this.state,
        status: 'conflict',
        notice: null,
        conflict: {
          base: this.state.document,
          baseRevision: this.state.revision,
          remote: change.document,
          remoteRevision: change.revision,
        },
      };
      this.emit();
      return;
    }

    if (change.document) {
      // 本页没有未落盘改动：静默跟上，不打断也不增加任何提示。
      this.state = { ...this.state, document: change.document, revision: change.revision };
      this.emit();
    }
  }

  private commit(update: (scenario: EnergyScenario) => EnergyScenario, notice: string): void {
    if (!this.state.document) return;
    const document = { ...this.state.document, scenarios: this.state.document.scenarios.map((scenario) => scenario.id === this.state.document?.activeScenarioId ? update(scenario) : scenario) };
    this.persist(document, notice);
  }

  private persist(document: EnergyDocument, notice: string): void {
    try {
      const { revision } = this.repository.save(document, this.state.revision);
      this.dirty = false;
      this.state = { ...this.state, document, revision, status: 'editing', notice: { kind: 'success', text: notice }, conflict: null };
    } catch (error) {
      if (error instanceof DocumentConflictError) {
        this.dirty = true;
        this.state = {
          ...this.state,
          document,
          status: 'conflict',
          notice: null,
          conflict: {
            base: document,
            baseRevision: this.state.revision,
            remote: error.remote?.document ?? null,
            remoteRevision: error.remote?.revision ?? this.state.revision,
          },
        };
      } else {
        // 配额等普通保存失败：保留本页内容并标记未落盘，之后收到远端更新仍会进入冲突流程。
        this.dirty = true;
        this.state = { ...this.state, document, status: 'error', notice: { kind: 'error', text: '保存失败，当前页面仍可继续编辑' } };
      }
    }
    this.emit();
  }

  private setNotice(notice: Notice): void {
    this.state = { ...this.state, status: notice.kind === 'error' ? 'error' : 'editing', notice };
    this.emit();
  }

  private emit(): void { this.listeners.forEach((listener) => listener(this.state)); }
}
