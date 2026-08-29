import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { cx } from "./ui.js";

/**
 * Three glyphs drawn by hand rather than pulled from an icon package. At this
 * count the dependency costs more than it saves, and these only need to read
 * clearly at 18px.
 */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[18px] shrink-0"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  upload: (
    <Glyph>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Glyph>
  ),
  negotiations: (
    <Glyph>
      <path d="M8 14H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      <path d="M18 10h-8a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h6l3 3v-3h-1a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2Z" />
    </Glyph>
  ),
  orders: (
    <Glyph>
      <path d="M15 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7Z" />
      <path d="M15 3v4h4" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </Glyph>
  ),
} as const;

export type NavItem = { to: string; label: string; icon: keyof typeof ICONS };

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "New quotation", icon: "upload" },
  { to: "/negotiations", label: "Negotiations", icon: "negotiations" },
  { to: "/purchase-orders", label: "Purchase orders", icon: "orders" },
];

function Wordmark() {
  return (
    <NavLink to="/" className="flex items-center gap-2.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-[11px] font-bold tracking-tight text-primary-ink">
        SQ
      </span>
      <span className="text-sm font-semibold tracking-wide">Smart Quotation</span>
    </NavLink>
  );
}

/**
 * `end` on the first item only: "/" is a prefix of every other route, so without
 * it the upload tab stays lit on every page.
 */
function itemProps(item: NavItem) {
  return { to: item.to, end: item.to === "/" };
}

export function Sidebar() {
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-edge bg-surface lg:flex">
      <div className="px-5 py-5">
        <Wordmark />
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            {...itemProps(item)}
            className={({ isActive }) =>
              cx(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition",
                isActive
                  ? "bg-surface-2 font-medium text-ink"
                  : "text-ink-dim hover:bg-surface-2/70 hover:text-ink",
              )
            }
          >
            {ICONS[item.icon]}
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-edge px-5 py-4">
        <a
          href="/docs"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-ink-faint transition hover:text-ink-dim"
        >
          API reference ↗
        </a>
      </div>
    </aside>
  );
}

/**
 * The same navigation for viewports too narrow to give up 240px to it. Kept as a
 * plain row rather than a drawer: three destinations do not need a hamburger.
 */
export function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-surface/90 backdrop-blur lg:hidden">
      <div className="flex items-center gap-4 overflow-x-auto px-5 py-3">
        <Wordmark />
        <nav className="flex items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              {...itemProps(item)}
              className={({ isActive }) =>
                cx(
                  "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm transition",
                  isActive
                    ? "bg-surface-2 font-medium text-ink"
                    : "text-ink-dim hover:bg-surface-2 hover:text-ink",
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
