import { useEffect, useRef } from 'react';
import type { ClipboardEvent, KeyboardEvent, ReactElement, RefObject } from 'react';

export type OtpInputProps = {
  /** Les chiffres saisis, sans séparateur (« 482190 »). */
  value: string;
  onChange(value: string): void;
  length?: number;
  /** État d'erreur : bordure et `aria-invalid` sur toutes les cases. */
  invalid?: boolean;
  /** Conteneur exposé à l'écran pour reprendre le focus après un code incorrect. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Place le focus sur la première case au montage. */
  autoFocus?: boolean;
};

/**
 * M8 : le code à 6 chiffres.
 * Six cases, chiffres uniquement, collage accepté, retour arrière case par case.
 * Une entrée part toujours de la première case vide : le « value » reste donc contigu.
 */
export function OtpInput({ value, onChange, length = 6, invalid = false, containerRef, autoFocus = false }: OtpInputProps): ReactElement {
  const cellsRef = useRef<Array<HTMLInputElement | null>>([]);
  const cells = Array.from({ length }, (_, i) => value[i] ?? '');

  const focusAt = (index: number): void => {
    const bounded = Math.max(0, Math.min(length - 1, index));
    cellsRef.current[bounded]?.focus();
  };

  useEffect(() => {
    if (autoFocus) cellsRef.current[0]?.focus();
  }, [autoFocus]);

  /** Distribue les chiffres reçus à partir d'une case de départ. */
  const writeFrom = (startIndex: number, digits: string): void => {
    const next = [...cells];
    let start = next[startIndex] ? startIndex : next.findIndex((cell) => !cell);
    if (start < 0) start = length - 1;
    for (let k = 0; k < digits.length && start + k < length; k += 1) next[start + k] = digits[k] ?? '';
    onChange(next.join(''));
    focusAt(Math.min(start + digits.length, length - 1));
  };

  const handleChange = (index: number, raw: string): void => {
    const digits = raw.replace(/\D/g, '');
    if (!digits) {
      // Effacement : la case repart vide, sans toucher aux autres.
      const next = [...cells];
      next[index] = '';
      onChange(next.join(''));
      return;
    }
    writeFrom(index, digits);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>, index: number): void => {
    const digits = event.clipboardData?.getData('text').replace(/\D/g, '') ?? '';
    if (!digits) return;
    event.preventDefault();
    writeFrom(index, digits);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number): void => {
    if (event.key === 'Backspace') {
      event.preventDefault();
      const next = [...cells];
      if (next[index]) {
        next[index] = '';
      } else {
        let previous = index - 1;
        while (previous >= 0 && !next[previous]) previous -= 1;
        if (previous < 0) return;
        next[previous] = '';
        onChange(next.join(''));
        focusAt(previous);
        return;
      }
      onChange(next.join(''));
      focusAt(index);
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAt(index - 1);
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAt(index + 1);
    }
  };

  return (
    <div className={`cp-otp${invalid ? ' cp-otp--bad' : ''}`} role="group" aria-label="Code à 6 chiffres" ref={containerRef}>
      {cells.map((cell, index) => (
        <input
          key={index}
          ref={(element) => {
            cellsRef.current[index] = element;
          }}
          className="cp-otp__cell"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Chiffre ${index + 1}`}
          aria-invalid={invalid || undefined}
          value={cell}
          onChange={(e) => handleChange(index, e.target.value)}
          onPaste={(e) => handlePaste(e, index)}
          onKeyDown={(e) => handleKeyDown(e, index)}
          onFocus={(e) => e.target.select()}
        />
      ))}
    </div>
  );
}
