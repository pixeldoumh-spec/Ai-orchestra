"use client";

import { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { MobileWorkspaceNav } from "@/components/MobileWorkspaceNav";

type IconName = "home"|"runs"|"knowledge"|"network"|"marketplace"|"billing"|"workspace"|"settings"|"user";

function Icon({ name }: { name: IconName }) {
  const base = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const p: Record<IconName, ReactNode> = {
    home:<><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
    runs:<><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></>,
    knowledge:<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/><path d="M8 8h8"/><path d="M8 11h6"/></>,
    network:<><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="m8.2 8.1 7.6 7.8"/><path d="M8.5 7h7"/></>,
    marketplace:<><path d="M4 9h16l-1-5H5z"/><path d="M6 9v10h12V9"/><path d="M9 19v-6h6v6"/></>,
    billing:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    workspace:<><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2"/><path d="M13 7h2"/><path d="M9 11h2"/><path d="M13 11h2"/><path d="M9 15h2"/><path d="M13 15h2"/></>,
    settings:<><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15 21 16.2l-1.7 2.9-1.9-.8a8.2 8.2 0 0 1-1.8 1L15.2 21h-3.4l-.4-1.7a8.2 8.2 0 0 1-1.8-1l-1.9.8L6 16.2 7.7 7l1.9.8a8.2 8.2 0 0 1 1.8-1L11.8 5h3.4l.4 1.8a8.2 8.2 0 0 1 1.8 1l1.9-.8L21 9.8 19.4 11a8.2 8.2 0 0 1 .2 2 8.2 8.2 0 0 1-.2 2Z"/></>,
    user:<><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/></>,
  };
  return <svg {...base}>{p[name]}</svg>;
}

const items = [
  { href:"/", label:"Home", icon:"home" as IconName },
  { href:"/runs", label:"Runs", icon:"runs" as IconName },
  { href:"/network", label:"Agent network", icon:"network" as IconName },
  { href:"/knowledge", label:"Knowledge", icon:"knowledge" as IconName },
  { href:"/marketplace", label:"Marketplace", icon:"marketplace" as IconName },
  { href:"/connectors", label:"Connectors", icon:"marketplace" as IconName },
  { href:"/billing", label:"Billing", icon:"billing" as IconName },
  { href:"/enterprise", label:"Workspace", icon:"workspace" as IconName },
];

export function OrchestraShell({ children, title, section }: { children: ReactNode; title: string; section?: string }) {
  const pathname = usePathname();
  const active = section ?? items.find((item) => item.href === pathname)?.label ?? "Workspace";

  return (
    <div className="orchestraApp orchestraSecondaryApp">
      <aside className="orchestraRail">
        <a className="orchestraBrand" href="/"><span className="brandMark">A</span><span>AI Orchestra</span></a>
        <a className="newTaskButton" href="/"><span>＋</span><span>New task</span></a>
        <nav className="orchestraNav" aria-label="Primary navigation">
          <div className="navGroup">
            <div className="navLabel">Workspace</div>
            {items.slice(0,6).map((item) => <a key={item.href} className={"navItem " + (active === item.label ? "active" : "")} href={item.href}><Icon name={item.icon}/><span>{item.label}</span></a>)}
          </div>
          <div className="navGroup">
            <div className="navLabel">Manage</div>
            {items.slice(6).map((item) => <a key={item.href} className={"navItem " + (active === item.label ? "active" : "")} href={item.href}><Icon name={item.icon}/><span>{item.label}</span></a>)}
            <a className="navItem" href="/auth/sign-in"><Icon name="user"/><span>Account</span></a>
          </div>
        </nav>
        <div className="railFooter">
          <div className="railStatus"><span className="statusDot"/><div><strong>Orchestra ready</strong><span>Governed execution</span></div></div>
          <a className="railSettings" href="/enterprise"><Icon name="settings"/><span>Settings</span></a>
        </div>
      </aside>
      <section className="orchestraMain">
        <header className="orchestraHeader">
          <div className="workspaceTitle"><span>{title}</span></div>
          <div className="headerActions"><span className="healthPill"><span className="statusDot"/> Healthy</span><a className="avatarButton" href="/auth/sign-in" aria-label="Account"><Icon name="user"/></a></div>
        </header>
        <main className="orchestraCanvas"><div className="secondaryContent">{children}</div></main>
      </section>
      <MobileWorkspaceNav />
    </div>
  );
}
