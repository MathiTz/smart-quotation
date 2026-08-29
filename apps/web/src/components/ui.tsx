import type { ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        "animate-in rounded-xl border border-edge bg-surface shadow-[0_1px_2px_rgba(16,18,24,0.04)]",
        className,
      )}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-edge px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-1 text-xs text-ink-dim">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

const BUTTON_VARIANTS = {
  primary: "bg-primary text-primary-ink font-semibold hover:brightness-125 shadow-sm",
  secondary: "bg-surface text-ink border border-edge-strong hover:bg-surface-2",
  ghost: "text-ink-dim hover:text-ink hover:bg-surface-2",
  danger: "bg-surface text-bad border border-bad/40 hover:bg-bad/8",
} as const;

export function Button({
  variant = "secondary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof BUTTON_VARIANTS }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm transition",
        "disabled:cursor-not-allowed disabled:opacity-40",
        BUTTON_VARIANTS[variant],
        className,
      )}
    />
  );
}

const TONES = {
  neutral: "bg-surface-2 text-ink-dim border-edge",
  good: "bg-good/10 text-good border-good/25",
  warn: "bg-warn/10 text-warn border-warn/25",
  bad: "bg-bad/10 text-bad border-bad/25",
  accent: "bg-accent/10 text-accent border-accent/25",
} as const;

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof TONES;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        // Deliberately wrappable: live agents write sentence-length concession
        // labels, and a pill that refuses to wrap drags the whole grid wider
        // than the viewport. Short status badges opt out with `shrink-0`.
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A match confidence at a glance. The colour is the signal; the tooltip carries
 * the number and how it was reached, because "0.82 fuzzy" means nothing to a
 * sourcing manager without the explanation.
 */
export function ConfidenceDot({ confidence, method }: { confidence: number; method: string }) {
  const tone =
    confidence >= 0.95 ? "bg-good" : confidence >= 0.8 ? "bg-warn" : confidence > 0 ? "bg-bad" : "bg-ink-faint";
  const label =
    confidence >= 0.95
      ? "Confident match"
      : confidence >= 0.8
        ? "Probable match, worth a look"
        : confidence > 0
          ? "Weak match, please check"
          : "No catalog match";

  return (
    <Hint content={`${label} — ${method}, ${Math.round(confidence * 100)}%`}>
      <span className={cx("inline-block size-2.5 shrink-0 rounded-full", tone)} />
    </Hint>
  );
}

export function Hint({
  content,
  children,
  /** `span` is invalid around block content, so callers wrapping a card pass "div". */
  as: Wrapper = "span",
}: {
  content: ReactNode;
  children: ReactNode;
  as?: "span" | "div";
}) {
  return (
    <Tooltip.Root delayDuration={120}>
      <Tooltip.Trigger asChild>
        <Wrapper className="cursor-help">{children}</Wrapper>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-lg bg-primary px-3 py-2 text-xs leading-relaxed text-primary-ink shadow-lg"
        >
          {content}
          <Tooltip.Arrow className="fill-primary" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: keyof typeof TONES;
}) {
  const body = (
    <div className="rounded-lg border border-edge bg-surface-2 px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-ink-dim">{label}</div>
      <div
        className={cx(
          "nums mt-1 text-lg font-semibold",
          tone === "good" && "text-good",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-bad",
          tone === "accent" && "text-accent",
        )}
      >
        {value}
      </div>
    </div>
  );
  return hint ? (
    <Hint content={hint} as="div">
      {body}
    </Hint>
  ) : (
    body
  );
}

/**
 * A segmented switch. On a light surface the selected option has to sit *above*
 * the track rather than below it, so the track is grey and the active pill is
 * white with a shadow. Inverting those two is the single easiest way to make a
 * light UI look like the wrong option is the one selected.
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode; hint?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cx("flex rounded-lg border border-edge bg-surface-2 p-0.5", className)}>
      {options.map((option) => {
        const active = option.value === value;
        const button = (
          <button
            key={String(option.value)}
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            className={cx(
              "whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition",
              active
                ? "bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(16,18,24,0.08)]"
                : "text-ink-dim hover:text-ink",
            )}
          >
            {option.label}
          </button>
        );
        return option.hint ? (
          <Hint key={String(option.value)} content={option.hint}>
            {button}
          </Hint>
        ) : (
          button
        );
      })}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-edge px-5 py-10 text-center text-sm text-ink-faint">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 text-sm text-ink-dim">
      <span className="size-3.5 animate-spin rounded-full border-2 border-edge border-t-accent" />
      {label}
    </div>
  );
}

/**
 * Shown in place of a screen that could not load, where there is genuinely
 * nothing else to display. Offers a retry, because the most common cause is the
 * API not being up yet and the second most common is a dropped connection —
 * both of which are fixed by trying again rather than by navigating away.
 */
export function ErrorPage({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="animate-in rounded-xl border border-bad/30 bg-bad/5 px-5 py-6">
      <h2 className="text-sm font-semibold text-bad">This did not load</h2>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-dim">{message}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/**
 * Shown next to the control that failed, leaving the rest of the screen alone.
 * An action failing is not a reason to throw away the work already on the page.
 */
export function ErrorNote({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-sm text-bad">
      {message}
    </p>
  );
}
