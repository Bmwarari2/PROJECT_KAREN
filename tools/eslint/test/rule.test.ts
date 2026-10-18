import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import rule from '../no-hardcoded-ui-strings.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } });

tester.run('no-hardcoded-ui-strings', rule as never, {
  valid: [
    { code: 'const a = <p>{t("common.save")}</p>;' },
    { code: 'const a = <button aria-label={t("common.close")} />;' },
    { code: 'const a = <span className="text-callout">{" · "}</span>;' },
    { code: 'const a = <p>{name}</p>;' },
  ],
  invalid: [
    { code: 'const a = <p>Save changes</p>;', errors: [{ messageId: 'text' }] },
    { code: 'const a = <button aria-label="Close" />;', errors: [{ messageId: 'attr' }] },
    { code: 'const a = <input placeholder={"Search people"} />;', errors: [{ messageId: 'attr' }] },
    { code: 'const a = <img alt="Company logo" />;', errors: [{ messageId: 'attr' }] },
  ],
});
