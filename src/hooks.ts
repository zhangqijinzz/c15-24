import { useEffect, useState } from 'react';
import { LocalEnergyRepository } from './repository';
import { EnergyLensViewModel, type EnergyLensState } from './viewModel';

export function useEnergyLens(): { vm: EnergyLensViewModel; state: EnergyLensState } {
  const [vm] = useState(() => new EnergyLensViewModel(new LocalEnergyRepository()));
  const [state, setState] = useState(vm.getState());
  useEffect(() => {
    const unsubscribe = vm.subscribe(setState);
    vm.initialize();
    return unsubscribe;
  }, [vm]);
  return { vm, state };
}
