'use client';
import * as React from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTrigger,
  Select,
  Sheet,
  SheetContent,
  SheetTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@thapsus/ui';
import { useT } from '@/lib/i18n-client';

export function GalleryInteractive() {
  const t = useT();
  const g = (k: string) => t(`gallery.${k}`);
  const toast = useToast();
  const [value, setValue] = React.useState('uk');
  return (
    <div className="mt-4 flex flex-col gap-6">
      <div className="flex flex-wrap gap-3">
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">{g('openDialog')}</Button>
          </DialogTrigger>
          <DialogContent
            title={g('dialogTitle')}
            description={g('sampleBody')}
            closeLabel={t('common.close')}
          >
            <Button>{t('common.confirm')}</Button>
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary">{g('openSheet')}</Button>
          </SheetTrigger>
          <SheetContent title={g('sheetTitle')} closeLabel={t('common.close')}>
            <p className="text-callout text-text-secondary">{g('sampleBody')}</p>
          </SheetContent>
        </Sheet>
        <Button
          variant="secondary"
          onClick={() => toast({ title: g('toastTitle'), body: g('sampleBody'), tone: 'success' })}
        >
          {g('showToast')}
        </Button>
      </div>
      <div className="max-w-xs">
        <Select
          label={t('common.organisation')}
          value={value}
          onValueChange={setValue}
          options={(['uk', 'eu', 'us'] as const).map((r) => ({ value: r, label: t(`regions.${r}`) }))}
        />
      </div>
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">{g('tabOne')}</TabsTrigger>
          <TabsTrigger value="b">{g('tabTwo')}</TabsTrigger>
        </TabsList>
        <TabsContent value="a" className="pt-4 text-callout">
          {g('sampleBody')}
        </TabsContent>
        <TabsContent value="b" className="pt-4 text-callout">
          {g('cardTitle')}
        </TabsContent>
      </Tabs>
    </div>
  );
}
