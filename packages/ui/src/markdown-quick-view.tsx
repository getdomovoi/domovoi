import type { ComponentPropsWithoutRef } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"

import { Button } from "./components/ui/button"
import { cn } from "./lib/utils"

export const maximumMarkdownCharacters = 32_768
export const maximumMarkdownLines = 500

export function boundedMarkdownSource(source: string): { source: string; truncated: boolean } {
  const normalizedSource = source.replace(/\r\n?/g, "\n")
  const lines = normalizedSource.split("\n")
  const selected = lines.slice(0, maximumMarkdownLines).map((line) => {
    const boundedIndent = line.replace(/^[ \t]{25,}/, "                        ")
    const boundedQuote = boundedIndent.replace(/^(?:>\s*){13,}/, "> > > > > > > > > > > > ")
    return boundedQuote.slice(0, 2_048)
  })
  const joined = selected.join("\n")
  const bounded = joined.slice(0, maximumMarkdownCharacters)
  return { source: bounded, truncated: lines.length > maximumMarkdownLines || joined.length > maximumMarkdownCharacters || bounded !== normalizedSource }
}

export function safeMarkdownUrl(url: string): string {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url
  return ""
}

function SafeLink({ href, children }: ComponentPropsWithoutRef<"a">) {
  const safe = href ? safeMarkdownUrl(href) : ""
  return safe
    ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>
}

export function MarkdownQuickView({
  source,
  canonicalAvailable = false,
  onOpenCanonical,
}: {
  source: string
  canonicalAvailable?: boolean
  onOpenCanonical?: () => void
}) {
  const bounded = boundedMarkdownSource(source)
  return (
    <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_h1]:text-[17px] [&_h1]:font-semibold [&_h2]:text-[15px] [&_h2]:font-semibold [&_h3]:text-[13px] [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_p]:m-0 [&_pre]:max-h-72 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-code [&_pre]:p-3 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a: SafeLink,
          img: () => null,
          code: ({ className, children }) => <code className={cn(className, "font-machine text-[0.92em]")}>{children}</code>,
        }}
      >
        {bounded.source}
      </ReactMarkdown>
      {bounded.truncated ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>Quick view truncated.</span>
          {canonicalAvailable && onOpenCanonical ? <Button variant="link" size="xs" onClick={onOpenCanonical}>Open full plan</Button> : null}
        </div>
      ) : null}
    </div>
  )
}
