/** Translated labels for document values the API returns as codes (categories, attachment types). */
type T = (key: string, vars?: Record<string, string | number>) => string;

/** A category in words; an unknown or customer-made category is shown as it was entered. */
export function categoryLabel(t: T, category: string): string {
  const key = `documents.categoryName.${category}`;
  const v = t(key);
  return v === key ? category : v;
}

/** What a document is: its attachment type when HR attached it, else its category. */
export function kindLabel(t: T, d: { category: string; attachmentType?: string | null }): string {
  return d.attachmentType ? t(`docAttach.type.${d.attachmentType}`) : categoryLabel(t, d.category);
}

export const byteSize = (bytes: number, locale: string) => {
  const mb = bytes >= 1024 * 1024;
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: mb ? 'megabyte' : 'kilobyte',
    unitDisplay: 'short',
    maximumFractionDigits: mb ? 1 : 0,
  }).format(mb ? bytes / 1024 / 1024 : Math.max(1, Math.round(bytes / 1024)));
};
