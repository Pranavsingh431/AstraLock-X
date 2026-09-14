import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names, resolving Tailwind conflicts in favour of the last one.
 *
 * Plain concatenation would leave `px-2 px-4` in the output, where the winner
 * depends on stylesheet order rather than call order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
