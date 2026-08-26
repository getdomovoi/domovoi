import type { SVGProps } from "react"

export function DomovoiMark({ reduced = false, ...props }: SVGProps<SVGSVGElement> & { reduced?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        d="M50 4C67 4 79 14 81 31C83 45 88 60 84 73C79 87 66 96 50 96C34 96 21 87 16 73C12 60 17 45 19 31C21 14 33 4 50 4ZM50 16C60 16 67 22 67 32C67 43 60 51 50 51C40 51 33 43 33 32C33 22 40 16 50 16Z"
      />
      <path d={reduced ? "M36.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0ZM54.4 32a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0-9.2 0Z" : "M38.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0-6.6 0ZM54.7 31a3.3 3.3 0 1 0 6.6 0a3.3 3.3 0 1 0-6.6 0ZM34 43C40 40 45 43 50 43C55 43 60 40 66 43C59 50 54 47 50 47C46 47 41 50 34 43Z"} />
    </svg>
  )
}
