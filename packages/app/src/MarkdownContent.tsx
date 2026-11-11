import { useMemo } from 'react';
import type { MouseEvent } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function MarkdownContent({ source, onOpenLink }: {
  source: string;
  onOpenLink: (url: string) => void;
}) {
  const html = useMemo(() => {
    const rendered = marked.parse(source, { async: false, gfm: true });
    return DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'img'],
      FORBID_ATTR: ['style'],
    });
  }, [source]);

  function followLink(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest('a');
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    event.preventDefault();
    const href = anchor.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) onOpenLink(href);
  }

  return <div className="markdown-content" onClick={followLink} dangerouslySetInnerHTML={{ __html: html }} />;
}
