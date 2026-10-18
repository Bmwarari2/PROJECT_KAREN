/**
 * Fails on user-facing text that does not come from the message catalogues:
 *  - JSX text containing letters
 *  - string literals in user-facing JSX attributes (aria-label, title, alt, placeholder, label, …)
 * Data values (names in fictional fixtures, ids) belong in JS expressions, not raw JSX text.
 */
const ATTRS = new Set(['aria-label', 'aria-description', 'title', 'alt', 'placeholder', 'label', 'closeLabel', 'description', 'body']);
const LETTERS = /\p{L}{2,}/u;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow hard-coded user-facing strings; use the i18n message catalogues' },
    messages: {
      text: 'Hard-coded UI text "{{text}}" — move it to the message catalogue and use t().',
      attr: 'Hard-coded {{attr}}="{{text}}" — move it to the message catalogue and use t().',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (text && LETTERS.test(text)) context.report({ node, messageId: 'text', data: { text: text.slice(0, 40) } });
      },
      JSXAttribute(node) {
        const name = typeof node.name.name === 'string' ? node.name.name : '';
        if (!ATTRS.has(name) || !node.value) return;
        const v = node.value;
        const literal = v.type === 'Literal' ? v.value : v.type === 'JSXExpressionContainer' && v.expression.type === 'Literal' ? v.expression.value : undefined;
        if (typeof literal === 'string' && LETTERS.test(literal)) context.report({ node, messageId: 'attr', data: { attr: name, text: literal.slice(0, 40) } });
      },
    };
  },
};
