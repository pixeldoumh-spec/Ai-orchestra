"use client";

import { ReactNode, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { MobileWorkspaceNav } from "@/components/MobileWorkspaceNav";

type IconName = "home"|"runs"|"knowledge"|"network"|"marketplace"|"billing"|"workspace"|"settings"|"user"|"agents"|"workflow"|"search"|"panel";

function Icon({ name, size = 15 }: { name: IconName; size?: number }) {
  const base = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const p: Record<IconName, ReactNode> = {
    home:<><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
    runs:<><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></>,
    knowledge:<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/><path d="M8 8h8"/><path d="M8 11h6"/></>,
    network:<><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="m8.2 8.1 7.6 7.8"/><path d="M8.5 7h7"/></>,
    marketplace:<><path d="M4 9h16l-1-5H5z"/><path d="M6 9v10h12V9"/><path d="M9 19v-6h6v6"/></>,
    billing:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    workspace:<><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2"/><path d="M13 7h2"/><path d="M9 11h2"/><path d="M13 11h2"/><path d="M9 15h2"/><path d="M13 15h2"/></>,
    settings:<><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15 21 16.2l-1.7 2.9-1.9-.8a8.2 8.2 0 0 1-1.8 1L15.2 21h-3.4l-.4-1.7a8.2 8.2 0 0 1-1.8-1l-1.9.8L6 16.2 7.7 7l1.9.8a8.2 8.2 0 0 1 1.8-1L11.8 5h3.4l.4 1.8a8.2 8.2 0 0 1 1.8 1l1.6-.8L21 9.8 19.4 11a8.2 8.2 0 0 1 .2 2 8.2 8.2 0 0 1-.2 2Z"/></>,
    user:<><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/></>,
    agents:<><circle cx="8" cy="8" r="2.5"/><circle cx="17" cy="8" r="2.5"/><path d="M4 19c.4-3.2 1.8-5 4-5s3.6 1.8 4 5"/><path d="M13 19c.3-2.8 1.7-5 4-5s3.6 1.8 4 5"/></>,
    workflow:<><rect x="4" y="5" width="6" height="5" rx="1"/><rect x="14" y="14" width="6" height="5" rx="1"/><path d="M10 7.5h4v9"/><path d="M7 10v4h10"/></>,
    search:<><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    panel:<><path d="M5 6h14"/><path d="M5 12h14"/><path d="M5 18h14"/></>,
  };
  return <svg {...base}>{p[name]}</svg>;
}

const groups = [
  {
    label: "Chat",
    items: [
      { href:"/", label:"New conversation", icon:"home" as IconName },
      { href:"/runs", label:"Runs", icon:"runs" as IconName },
      { href:"/knowledge", label:"Knowledge", icon:"knowledge" as IconName },
    ],
  },
  {
    label: "Orchestration",
    items: [
      { href:"/workflow", label:"Workflow Studio", icon:"workflow" as IconName },
      { href:"/agents", label:"Agents", icon:"agents" as IconName },
      { href:"/network", label:"Agent network", icon:"network" as IconName },
    ],
  },
  {
    label: "Workspace",
    items: [
      { href:"/marketplace", label:"Marketplace", icon:"marketplace" as IconName },
      { href:"/connectors", label:"Connectors", icon:"marketplace" as IconName },
      { href:"/billing", label:"Billing", icon:"billing" as IconName },
      { href:"/enterprise", label:"Workspace settings", icon:"workspace" as IconName },
    ],
  },
];

export function OrchestraShell({ children, title, section }: { children: ReactNode; title: string; section?: string }) {
  const pathname = usePathname();
  const active = section ?? groups.flatMap((group) => group.items).find((item) => item.href === pathname)?.label ?? "Workspace";
  const [recentTasks, setRecentTasks] = useState<any[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    const open = () => setSearchOpen(true);
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("orchestra:search", open);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("orchestra:search", open);
      window.removeEventListener("keydown", key);
    };
  }, []);

  useEffect(() => {
    let live = true;
    void fetch("/api/tasks?limit=8")
      .then(async (response) => (response.ok ? response.json() : { tasks: [] }))
      .then((data) => { if (live) setRecentTasks(Array.isArray(data.tasks) ? data.tasks : []); })
      .catch(() => {});
    return () => { live = false; };
  }, [pathname]);

  return (
    <div className="orchestraApp orchestraChatLike">
      <aside className="orchestraRail" aria-label="AI Orchestra navigation">
        <div className="orchestraRailTop">
          <a className="orchestraBrand" href="/">
            <span className="brandMark">A</span>
            <span className="brandWord">AI Orchestra</span>
          </a>

          <a className="newTaskButton" href="/">
            <span className="newTaskIcon">＋</span>
            <span>New task</span>
          </a>

          <button className="sidebarSearch" type="button" onClick={() => window.dispatchEvent(new CustomEvent("orchestra:search"))}>
            <Icon name="search" size={14} />
            <span>Search</span>
            <kbd>⌘K</kbd>
          </button>

          <nav className="orchestraNav" aria-label="Primary">
            {groups.map((group) => (
              <div className="navGroup" key={group.label}>
                <div className="navLabel">{group.label}</div>
                {group.items.map((item) => (
                  <a
                    key={item.href}
                    className={"navItem " + (active === item.label ? "active" : "")}
                    href={item.href}
                  >
                    <Icon name={item.icon} size={15} />
                    <span>{item.label}</span>
                  </a>
                ))}
              </div>
            ))}
          </nav>

          {recentTasks.length > 0 && (
            <section className="sidebarRecents" aria-label="Recent conversations">
              <div className="navLabel">Recents</div>
              <div className="sidebarRecentsList">
                {recentTasks.slice(0, 6).map((task: any) => (
                  <a key={task.id} href={"/runs?task=" + encodeURIComponent(task.id)} className="sidebarRecent">
                    <span>{task.goal}</span>
                    <small>{formatRecentStatus(task.status)}</small>
                  </a>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="railFooter chatRailFooter">
          <div className="railStatus">
            <span className="statusDot" />
            <div><strong>Orchestra ready</strong><span>Governed execution</span></div>
          </div>
          <a className="railSettings" href="/enterprise"><Icon name="settings" /><span>Settings</span></a>
          <a className="railAccount" href="/auth/sign-in">
            <span className="accountAvatar"><Icon name="user" size={14}/></span>
            <span><strong>Account</strong><small>Workspace profile</small></span>
          </a>
        </div>
      </aside>

      <section className="orchestraMain">
        <header className="orchestraHeader orchestraChatHeader">
          <div className="mobileHeaderMenu"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("orchestra:mobile-menu"))} aria-label="Open navigation"><Icon name="panel" size={19}/></button></div>
          <div className="workspaceTitle">
            <span>{title === "Home" ? "AI Orchestra" : title}</span>
          </div>
          <div className="headerActions">
            <a className="avatarButton" href="/auth/sign-in" aria-label="Account"><Icon name="user" size={15}/></a>
          </div>
        </header>
        <main className="orchestraCanvas orchestraChatCanvas">
          <div className="orchestraContent orchestraChatContent">{children}</div>
        </main>
      </section>

      <MobileWorkspaceNav />
      {searchOpen && (
        <div className="orchestraSearchOverlay" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) setSearchOpen(false);
        }}>
          <div className="orchestraSearchDialog" role="dialog" aria-modal="true" aria-label="Search workspace">
            <div className="orchestraSearchHead">
              <Icon name="search" size={16} />
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search runs and workspace"
                aria-label="Search runs and workspace"
              />
              <button type="button" onClick={() => setSearchOpen(false)} aria-label="Close search">Esc</button>
            </div>
            <div className="orchestraSearchResults">
              {(search ? recentTasks.filter((task: any) => String(task.goal ?? "").toLowerCase().includes(search.toLowerCase())) : recentTasks).slice(0, 8).map((task: any) => (
                <a key={task.id} href={"/runs?task=" + encodeURIComponent(task.id)} onClick={() => setSearchOpen(false)}>
                  <span>{task.goal}</span>
                  <small>{formatRecentStatus(task.status)}</small>
                </a>
              ))}
              {((search ? recentTasks.filter((task: any) => String(task.goal ?? "").toLowerCase().includes(search.toLowerCase())) : recentTasks).length === 0) && (
                <div className="orchestraSearchEmpty">No matching runs yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatRecentStatus(value: unknown) {
  const text = String(value ?? "queued").replace(/[_-]+/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
