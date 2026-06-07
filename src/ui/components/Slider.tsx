/**
 * Slider — a brand-tokened single-value slider built on Radix `Slider`
 * (keyboard + ARIA). Thin local wrapper so the dependency stays swappable.
 */

import * as RadixSlider from '@radix-ui/react-slider';
import './Slider.css';

export interface SliderProps {
  value: number;
  onValueChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel: string;
  disabled?: boolean;
}

export function Slider({ value, onValueChange, min, max, step, ariaLabel, disabled }: SliderProps) {
  return (
    <RadixSlider.Root
      className="ds-slider"
      value={[value]}
      onValueChange={(values) => onValueChange(values[0] ?? value)}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      {...(disabled !== undefined ? { disabled } : {})}
    >
      <RadixSlider.Track className="ds-slider__track">
        <RadixSlider.Range className="ds-slider__range" />
      </RadixSlider.Track>
      <RadixSlider.Thumb className="ds-slider__thumb" aria-label={ariaLabel} />
    </RadixSlider.Root>
  );
}
