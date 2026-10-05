"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

type IconName = "home" | "runs" | "network" | "knowledge" | "marketplace" | "billing" | "workspace" | "user" | "plus";

function Icon({ name, size = 17 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
    runs: <><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></>,
    network: <><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="m8.2 8.1 7.6 7.8"/><path d="M8.5 7h7"/></>,
    knowledge: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/><path d="M8 8h8"/><path d="M8 11h6"/></>,
    marketplace: <><path d="M4 9h16l-1-5H5z"/><path d="M6 9v10h12V9"/><path d="M9 19v-6h6v6"/></>,
    billing: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    workspace: <><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2"/><path d="M13 7h2"/><path d="M9 11h2"/><path d="M13 11h2"/><path d="M9 15h2"/><path d="M13 15h2"/></>,
    user: <><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  };

  return <svg {...common}>{paths[name]}</svg>;
}

const primary = [
  { href: "/", label: "Home", icon: "home" as IconName },
  { href: "/runs", label: "Runs", icon: "runs" as IconName },
  { href: "/network", label: "Network", icon: "network" as IconName },
  { href: "/knowledge", label: "Knowledge", icon: "knowledge" as IconName },
];

const secondary = [
  { href: "/marketplace", label: "Marketplace", icon: "marketplace" as IconName },
  { href: "/connectors", label: "Connectors", icon: "marketplace" as IconName },
  { href: "/billing", label: "Billing", icon: "billing" as IconName },
  { href: "/enterprise", label: "Workspace", icon: "workspace" as IconName },
  { href: "/auth/sign-in", label: "Account", icon: "user" as IconName },
];

export function MobileWorkspaceNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const activePrimary = primary.find((item) => item.href === pathname);

  return (
    <>
      {open && (
        <button
          type="button"
          className="mobileNavBackdrop"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}

      {open && (
        <section className="mobileMoreSheet" aria-label="More workspace navigation">
          <div className="mobileMoreHeader">
            <div>
              <strong>Workspace</strong>
              <span>All Orchestra surfaces</span>
            </div>
            <button type="button" className="mobileMoreClose" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <div className="mobileMoreGrid">
            {secondary.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className={"mobileMoreItem " + (pathname === item.href ? "active" : "")}
                onClick={() => setOpen(false)}
              >
                <span className="mobileMoreIcon"><Icon name={item.icon} /></span>
                <span>{item.label}</span>
              </a>
            ))}
          </div>

          <a className="mobileQuickTask" href="/" onClick={() => setOpen(false)}>
            <span className="mobileMoreIcon"><Icon name="plus" size={16} /></span>
            <span>
              <strong>New task</strong>
              <small>Open the Orchestra composer</small>
            </span>
          </a>
        </section>
      )}

      <nav className="mobileWorkspaceNav" aria-label="Mobile primary navigation">
        {primary.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className={"mobileNavItem " + (activePrimary?.href === item.href ? "active" : "")}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </a>
        ))}
        <button
          type="button"
          className={"mobileNavItem " + (open ? "active" : "")}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="mobile-workspace-more"
        >
          <Icon name="plus" />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}
