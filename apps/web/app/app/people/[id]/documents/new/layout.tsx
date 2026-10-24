import { Messages } from '@/lib/i18n-scope';

/** Sending a document for signature (16.11): the send page's own messages, on top of the person's. */
export default function NewDocumentLayout({ children }: { children: React.ReactNode }) {
  return <Messages ns={['docSend', 'docFields', 'docTpl.sample', 'docTpl.sampleHint']}>{children}</Messages>;
}
