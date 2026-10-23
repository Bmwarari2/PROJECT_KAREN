'use client';
import * as React from 'react';
import { Coffee, Delete, LogIn, LogOut, Monitor } from 'lucide-react';
import { Button, Card, Field, Input } from '@thapsus/ui';
import { api, ApiProblem } from '@/lib/api';
import { useT } from '@/lib/i18n-client';

const TOKEN_KEY = 'thr.kiosk.token';
type Kind = 'in' | 'out' | 'break_start' | 'break_end';

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Shared kiosk: paired once with a token from Clock in → Shared kiosks (kept on this device only),
 * then anyone can clock with their employee number and PIN. Errors never reveal whether a number exists.
 */
export default function KioskPage() {
  const t = useT();
  const [token, setToken] = React.useState<string | null>(null);
  const [name, setName] = React.useState<string | null>(null);
  const [checked, setChecked] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [number, setNumber] = React.useState('');
  const [pin, setPin] = React.useState('');
  const [message, setMessage] = React.useState<{ text: string; tone: 'success' | 'danger' } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const numberRef = React.useRef<HTMLInputElement>(null);

  const verify = React.useCallback(
    async (tok: string) => {
      try {
        const s = await api<{ name: string }>('/v1/kiosk/session', {
          headers: { authorization: `Kiosk ${tok}` },
        });
        localStorage.setItem(TOKEN_KEY, tok);
        setToken(tok);
        setName(s.name);
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        setToken(null);
        setName(null);
        if (tok) setMessage({ text: t('kiosk.notPaired'), tone: 'danger' });
      } finally {
        setChecked(true);
      }
    },
    [t],
  );

  React.useEffect(() => {
    const m = /pair=([^&]+)/.exec(window.location.hash);
    if (m) {
      history.replaceState(null, '', window.location.pathname);
      void verify(decodeURIComponent(m[1]!));
      return;
    }
    const tok = storedToken();
    if (tok) void verify(tok);
    else setChecked(true);
  }, [verify]);

  React.useEffect(() => {
    if (!message) return;
    const id = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(id);
  }, [message]);

  async function clock(kind: Kind) {
    if (!token || !number || pin.length < 4) {
      setMessage({ text: t('kiosk.fillIn'), tone: 'danger' });
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ status: string; name: string }>('/v1/kiosk/clock', {
        method: 'POST',
        headers: { authorization: `Kiosk ${token}` },
        json: { employeeNumber: number.trim(), pin, kind, clientEventId: `kiosk-${crypto.randomUUID()}` },
      });
      setMessage({
        text: t(r.status === 'duplicate' ? 'kiosk.duplicate' : 'kiosk.done', {
          kind: t(`clock.kind.${kind}`),
          name: r.name,
        }),
        tone: 'success',
      });
      setNumber('');
      numberRef.current?.focus();
    } catch (err) {
      const code = err instanceof ApiProblem ? err.status : 0;
      const key =
        code === 423
          ? 'kiosk.locked'
          : code === 429
            ? 'kiosk.rateLimited'
            : code === 401 && err instanceof ApiProblem && err.code === 'unauthorised'
              ? 'kiosk.notPaired'
              : code === 401
                ? 'kiosk.invalid'
                : code === 0
                  ? 'kiosk.offline'
                  : 'common.error';
      setMessage({ text: t(key), tone: 'danger' });
    } finally {
      setPin('');
      setBusy(false);
    }
  }

  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[var(--content-width)] flex-col gap-6 px-4 py-8"
    >
      <div className="flex items-center gap-3">
        <Monitor aria-hidden className="h-6 w-6 stroke-[1.5] text-accent" />
        <h1 className="text-title-2">{name ? t('kiosk.paired', { name }) : t('kiosk.title')}</h1>
      </div>
      <p
        aria-live="assertive"
        role="status"
        data-testid="kiosk-message"
        className={`min-h-8 text-title-3 ${message?.tone === 'danger' ? 'text-danger' : 'text-success'}`}
      >
        {message?.text ?? ''}
      </p>
      {!checked ? null : !token ? (
        <Card>
          <h2 className="text-title-3">{t('kiosk.pairTitle')}</h2>
          <p className="mt-1 text-callout text-text-secondary">{t('kiosk.pairBody')}</p>
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const m = /(kio_[A-Za-z0-9._-]+)/.exec(code);
              void verify(m ? m[1]! : code.trim());
            }}
          >
            <Field id="pair-code" label={t('kiosk.pairLabel')} className="w-full sm:max-w-md">
              {(p) => (
                <Input
                  {...p}
                  required
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              )}
            </Field>
            <Button type="submit">{t('kiosk.pair')}</Button>
          </form>
        </Card>
      ) : (
        <Card className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="kiosk-number" label={t('kiosk.number')}>
              {(p) => (
                <Input
                  {...p}
                  ref={numberRef}
                  autoComplete="off"
                  autoCapitalize="characters"
                  required
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  className="h-12 text-title-3"
                />
              )}
            </Field>
            <Field id="kiosk-pin" label={t('kiosk.pin')}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={8}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  className="h-12 text-title-3 tracking-widest"
                />
              )}
            </Field>
          </div>
          <div
            role="group"
            aria-label={t('kiosk.pad')}
            className="grid max-w-sm grid-cols-3 gap-3 self-center sm:self-start"
          >
            {digits.map((d) => (
              <Button
                key={d}
                type="button"
                variant="secondary"
                size="lg"
                className="h-16 text-title-3"
                disabled={busy}
                aria-label={t('kiosk.digit', { digit: d })}
                onClick={() => setPin((p) => (p + d).slice(0, 8))}
              >
                {d}
              </Button>
            ))}
            <Button type="button" variant="ghost" size="lg" className="h-16" onClick={() => setPin('')}>
              {t('kiosk.clear')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-16 text-title-3"
              disabled={busy}
              aria-label={t('kiosk.digit', { digit: '0' })}
              onClick={() => setPin((p) => (p + '0').slice(0, 8))}
            >
              0
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="lg"
              className="h-16"
              aria-label={t('kiosk.backspace')}
              onClick={() => setPin((p) => p.slice(0, -1))}
            >
              <Delete aria-hidden className="h-6 w-6 stroke-[1.5]" />
            </Button>
          </div>
          <div className="grid gap-3 sm:grid-cols-4">
            <Button size="lg" className="h-16" onClick={() => clock('in')} loading={busy}>
              <LogIn aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.in')}
            </Button>
            <Button size="lg" className="h-16" onClick={() => clock('out')} disabled={busy}>
              <LogOut aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.out')}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="h-16"
              onClick={() => clock('break_start')}
              disabled={busy}
            >
              <Coffee aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.breakStart')}
            </Button>
            <Button
              size="lg"
              variant="secondary"
              className="h-16"
              onClick={() => clock('break_end')}
              disabled={busy}
            >
              <Coffee aria-hidden className="h-5 w-5 stroke-[1.5]" />
              {t('clock.breakEnd')}
            </Button>
          </div>
          <Button
            variant="link"
            className="self-start"
            onClick={() => {
              localStorage.removeItem(TOKEN_KEY);
              setToken(null);
              setName(null);
            }}
          >
            {t('kiosk.unpair')}
          </Button>
        </Card>
      )}
    </main>
  );
}
