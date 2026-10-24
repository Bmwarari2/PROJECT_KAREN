'use client';
import * as React from 'react';
import { Eraser } from 'lucide-react';
import { Button, Field, Input } from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';
import styles from './signature-input.module.css';

export interface SignatureValue {
  typedName: string;
  method: 'typed' | 'drawn';
  /** A drawn signature as a PNG data URL. */
  drawing?: string;
}

type Point = { x: number; y: number };
/** The ink drawn signatures are exported in for the PDF (the API stamps typed ones in the same pen blue). */
const PDF_INK = '#0d1f59';

/**
 * How someone signs (16.13, ADR-0197). The typed name is always there, works by keyboard alone and is the
 * accessible alternative: it is the printed name, and by default the signature too, shown in the open-licence
 * handwriting font the PDF uses. Drawing is optional: by finger, mouse or stylus on a pad (pointer events), with
 * a clear button. The drawing is exported as a PNG in pen ink, whatever the theme.
 */
export function SignatureInput({
  id,
  value,
  onChange,
}: {
  id: string;
  value: SignatureValue;
  onChange: (v: SignatureValue) => void;
}) {
  const t = useT();
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const strokes = React.useRef<Point[][]>([]);
  const drawing = React.useRef(false);
  const [hasInk, setHasInk] = React.useState(false);

  const paint = React.useCallback((target: HTMLCanvasElement, ink: string, scale: number) => {
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, target.width, target.height);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ink;
    for (const s of strokes.current) {
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      if (s.length === 1) ctx.lineTo(s[0]!.x + 0.1, s[0]!.y + 0.1);
      ctx.stroke();
    }
  }, []);

  const redraw = React.useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const { width, height } = c.getBoundingClientRect();
    if (c.width !== Math.round(width * ratio)) {
      c.width = Math.round(width * ratio);
      c.height = Math.round(height * ratio);
    }
    paint(c, getComputedStyle(c).color, ratio);
  }, [paint]);

  const exportPng = React.useCallback(() => {
    const c = canvas.current;
    if (!c) return undefined;
    const { width, height } = c.getBoundingClientRect();
    const out = document.createElement('canvas');
    out.width = Math.round(width * 2);
    out.height = Math.round(height * 2);
    paint(out, PDF_INK, 2);
    return out.toDataURL('image/png');
  }, [paint]);

  React.useEffect(() => {
    if (value.method !== 'drawn') return;
    redraw();
    const ro = new ResizeObserver(redraw);
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
  }, [value.method, redraw]);

  const at = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange({ ...value, method: 'drawn', drawing: strokes.current.length ? exportPng() : undefined });
  };

  return (
    <div className="flex flex-col gap-3">
      <Field id={`${id}-name`} label={t('documents.typedName')}>
        {(p) => (
          <Input
            {...p}
            required
            minLength={2}
            maxLength={120}
            value={value.typedName}
            onChange={(e) => onChange({ ...value, typedName: e.target.value })}
            autoComplete="name"
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-callout font-semibold">{t('docSignature.how')}</legend>
        {(['typed', 'drawn'] as const).map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-3 text-callout">
            <input
              type="radio"
              name={`${id}-method`}
              checked={value.method === m}
              onChange={() =>
                onChange({ ...value, method: m, drawing: m === 'drawn' && hasInk ? exportPng() : undefined })
              }
              className="h-5 w-5 accent-[var(--color-accent)]"
            />
            {t(`docSignature.method.${m}`)}
          </label>
        ))}
      </fieldset>
      {value.method === 'typed' ? (
        <div className="flex flex-col gap-1">
          <p className="text-footnote text-text-secondary">{t('docSignature.preview')}</p>
          {/* decorative: the same name is in the field above */}
          <p
            aria-hidden
            className={`${styles.script} min-h-14 overflow-hidden rounded-md border border-border bg-surface px-3 text-accent`}
          >
            {value.typedName.trim() || ' '}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p id={`${id}-pad-hint`} className="text-footnote text-text-secondary">
            {t('docSignature.padHint')}
          </p>
          <canvas
            ref={canvas}
            role="img"
            aria-label={hasInk ? t('docSignature.padDrawn') : t('docSignature.padLabel')}
            aria-describedby={`${id}-pad-hint`}
            className={`${styles.pad} h-40 w-full rounded-md border border-border bg-surface text-text`}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drawing.current = true;
              strokes.current.push([at(e)]);
              setHasInk(true);
              redraw();
            }}
            onPointerMove={(e) => {
              if (!drawing.current) return;
              strokes.current.at(-1)!.push(at(e));
              redraw();
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
          />
          <Button
            type="button"
            variant="secondary"
            className="min-h-11 self-start"
            disabled={!hasInk}
            onClick={() => {
              strokes.current = [];
              setHasInk(false);
              redraw();
              onChange({ ...value, drawing: undefined });
            }}
          >
            <Eraser aria-hidden className="h-4 w-4 stroke-[1.5]" />
            {t('docSignature.clear')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Whether a signature is ready to send: a name, and a drawing when drawing. */
export const signatureReady = (v: SignatureValue) =>
  v.typedName.trim().length >= 2 && (v.method === 'typed' || !!v.drawing);

/** The request body fields for a signature. */
export const signatureBody = (v: SignatureValue) =>
  v.method === 'drawn' && v.drawing
    ? { typedName: v.typedName.trim(), method: 'drawn' as const, drawing: v.drawing }
    : { typedName: v.typedName.trim(), method: 'typed' as const };
