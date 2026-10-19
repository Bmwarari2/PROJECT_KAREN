import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from '../src/components/primitives';

describe('Button', () => {
  it('renders a native button, with a hidden spinner and aria-busy while loading', () => {
    const html = renderToStaticMarkup(h(Button, { loading: true }, 'Save'));
    expect(html).toMatch(/^<button[^>]*aria-busy="true"[^>]*disabled=""/);
    expect(html).toContain('<span aria-hidden="true"');
    expect(html).toContain('Save</button>');
  });

  it('asChild renders the child element (a link) with the button styles and does not crash', () => {
    const html = renderToStaticMarkup(h(Button, { asChild: true, variant: 'secondary', size: 'sm' }, h('a', { href: '/app/people/new' }, 'Add employee')));
    expect(html.startsWith('<a ')).toBe(true);
    expect(html).toContain('href="/app/people/new"');
    expect(html).toContain('rounded-pill');
    expect(html).toContain('h-8');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('disabled=');
    expect(html).toContain('>Add employee</a>');
  });

  it('asChild while loading keeps one element: the spinner moves inside the link, which is marked busy and disabled', () => {
    const html = renderToStaticMarkup(h(Button, { asChild: true, loading: true }, h('a', { href: '/app/reports' }, 'Open')));
    expect(html).toMatch(/^<a [^>]*aria-busy="true"/);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toMatch(/<a [^>]*><span aria-hidden="true"[^>]*><\/span>Open<\/a>$/);
  });

  it('asChild merges the child class names and keeps its own props', () => {
    const html = renderToStaticMarkup(h(Button, { asChild: true, className: 'mt-3' }, h('a', { href: '/x', className: 'no-underline', 'aria-label': 'Go' }, 'Go')));
    expect(html).toContain('mt-3');
    expect(html).toContain('no-underline');
    expect(html).toContain('aria-label="Go"');
  });
});
