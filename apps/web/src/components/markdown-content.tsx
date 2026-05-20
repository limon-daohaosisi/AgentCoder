import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

type MarkdownContentProps = {
  children: string;
  className?: string;
};

const markdownPlugins = [remarkGfm, remarkBreaks];

export function MarkdownContent({
  children,
  className = ''
}: MarkdownContentProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        components={{
          h1: ({ children: content }) => (
            <h1 className="mb-4 mt-2 text-2xl font-semibold tracking-tight text-white">
              {content}
            </h1>
          ),
          h2: ({ children: content }) => (
            <h2 className="mb-3 mt-5 text-xl font-semibold tracking-tight text-white">
              {content}
            </h2>
          ),
          h3: ({ children: content }) => (
            <h3 className="mb-2 mt-4 text-lg font-semibold text-white/95">
              {content}
            </h3>
          ),
          h4: ({ children: content }) => (
            <h4 className="mb-2 mt-3 text-base font-semibold text-white/90">
              {content}
            </h4>
          ),
          p: ({ children: content }) => (
            <p className="my-2 whitespace-pre-wrap text-sm leading-7 text-white/88">
              {content}
            </p>
          ),
          ul: ({ children: content }) => (
            <ul className="my-3 list-disc space-y-1 pl-5 text-sm leading-7 text-white/88 marker:text-white/55">
              {content}
            </ul>
          ),
          ol: ({ children: content }) => (
            <ol className="my-3 list-decimal space-y-1 pl-5 text-sm leading-7 text-white/88 marker:text-white/55">
              {content}
            </ol>
          ),
          li: ({ children: content }) => <li className="pl-1">{content}</li>,
          strong: ({ children: content }) => (
            <strong className="font-semibold text-white">{content}</strong>
          ),
          em: ({ children: content }) => (
            <em className="italic text-white/92">{content}</em>
          ),
          blockquote: ({ children: content }) => (
            <blockquote className="my-3 border-l-2 border-white/12 pl-4 text-white/72 italic">
              {content}
            </blockquote>
          ),
          code: ({ children: content, className: codeClassName }) => {
            const isBlock = Boolean(codeClassName);

            if (!isBlock) {
              return (
                <code className="rounded bg-white/8 px-1.5 py-0.5 text-[13px] text-white/92">
                  {content}
                </code>
              );
            }

            return <code className={codeClassName}>{content}</code>;
          },
          pre: ({ children: content }) => (
            <pre className="my-3 overflow-x-auto rounded-[14px] bg-[#111111] px-4 py-3 text-xs leading-6 text-white/80">
              {content}
            </pre>
          ),
          a: ({ children: content, href }) => (
            <a
              className="text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-white"
              href={href}
              rel="noreferrer"
              target="_blank"
            >
              {content}
            </a>
          ),
          hr: () => <hr className="my-4 border-0 border-t border-white/8" />
        }}
        remarkPlugins={markdownPlugins}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
