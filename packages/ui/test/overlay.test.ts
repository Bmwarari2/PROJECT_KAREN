import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTrigger, Sheet, SheetContent } from '../src/components/dialog';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../src/components/menu';
import { Popover, PopoverContent, PopoverTrigger } from '../src/components/popover';

// Overlays start light (ADR-0186): nothing behind a closed overlay mounts, and a popover's or menu's
// trigger is a plain button until the overlay is first opened.
describe('overlays before they are first opened', () => {
  it('a closed popover renders a stand-in trigger with the same props and no content', () => {
    const html = renderToStaticMarkup(
      h(
        Popover,
        null,
        h(PopoverTrigger, { className: 'filters', 'aria-label': 'Filters' }, 'Filters'),
        h(PopoverContent, null, 'Choose a department'),
      ),
    );
    expect(html).toBe(
      '<button type="button" aria-haspopup="dialog" aria-expanded="false" data-state="closed" class="filters" aria-label="Filters">Filters</button>',
    );
  });

  it('asChild keeps the child element as the stand-in trigger', () => {
    const html = renderToStaticMarkup(
      h(
        Menu,
        null,
        h(MenuTrigger, { asChild: true }, h('a', { href: '#more' }, 'More')),
        h(MenuContent, null),
      ),
    );
    expect(html).toBe(
      '<a href="#more" aria-haspopup="menu" aria-expanded="false" data-state="closed">More</a>',
    );
  });

  it('a popover opened from outside uses the Radix trigger straight away', () => {
    const html = renderToStaticMarkup(
      h(Popover, { open: true }, h(PopoverTrigger, null, 'Filters'), h(PopoverContent, null, 'Choose')),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-state="open"');
    expect(html).toMatch(/aria-controls="[^"]+"/);
  });

  it('a menu opened by default uses the Radix trigger', () => {
    const html = renderToStaticMarkup(
      h(
        Menu,
        { defaultOpen: true },
        h(MenuTrigger, null, 'Account'),
        h(MenuContent, null, h(MenuItem, null, 'Sign out')),
      ),
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-state="open"');
  });

  it('closed dialogs and sheets keep their triggers and mount no content', () => {
    const html = renderToStaticMarkup(
      h(
        'div',
        null,
        h(
          Dialog,
          null,
          h(DialogTrigger, null, 'Open'),
          h(DialogContent, { title: 'Title', closeLabel: 'Close' }, 'Body'),
        ),
        h(Sheet, { open: false }, h(SheetContent, { title: 'Menu', closeLabel: 'Close' }, 'Links')),
      ),
    );
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('Body');
    expect(html).not.toContain('Links');
  });
});
