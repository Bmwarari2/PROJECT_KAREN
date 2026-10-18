import { describe, expect, it } from 'vitest';
import { buttonVariants, cn } from '../src/components/primitives';

describe('cn (tailwind-merge with design tokens)', () => {
  it('keeps text colour and text size together', () => {
    expect(buttonVariants({ variant: 'primary', size: 'md' })).toContain('text-on-accent');
    expect(cn('text-on-accent', 'text-callout').split(' ')).toEqual(['text-on-accent', 'text-callout']);
  });
  it('still resolves real conflicts', () => {
    expect(cn('text-callout', 'text-body')).toBe('text-body');
    expect(cn('text-text', 'text-danger')).toBe('text-danger');
  });
});
