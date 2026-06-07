/**
 * Switch — a brand-tokened toggle built on Radix `Switch` (keyboard + ARIA
 * switch semantics). Thin local wrapper so the dependency stays swappable.
 */

import * as RadixSwitch from '@radix-ui/react-switch';
import './Switch.css';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export function Switch({ checked, onCheckedChange, id, ariaLabel, disabled }: SwitchProps) {
  return (
    <RadixSwitch.Root
      className="switch"
      checked={checked}
      onCheckedChange={onCheckedChange}
      {...(id !== undefined ? { id } : {})}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <RadixSwitch.Thumb className="switch__thumb" />
    </RadixSwitch.Root>
  );
}
