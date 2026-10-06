"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";

type IconName = "home"|"runs"|"network"|"knowledge"|"marketplace"|"billing"|"workspace"|"user"|"plus"|"more"|"agents"|"workflow"|"search"|"panel";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width:size, height:size, viewBox:"0 0 24 24", fill:"none", stroke:"currentColor", strokeWidth:1.8, strokeLinecap:"round" as const, strokeLinejoin:"round" as const, "aria-hidden":true };
  const paths: Record<IconName, ReactNode> = {
    home:<><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
    runs:<><path d="M8 6h12"/><path d="M8 12h12"/><path d="M8 18h12"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/></>,
    network:<><circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="17" r="2.5"/><circle cx="18" cy="7" r="2.5"/><path d="m8.2 8.1 7.6 7.8"/><path d="M8.5 7h7"/></>,
    knowledge:<><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/><path d="M8 8h8"/><path d="M8 11h6"/></>,
    marketplace:<><path d="M4 9h16l-1-5H5z"/><path d="M6 9v10h12V9"/><path d="M9 19v-6h6v6"/></>,
    billing:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h4"/></>,
    workspace:<><rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M9 7h2"/><path d="M13 7h2"/><path d="M9 11h2"/><path d="M13 11h2"/><path d="M9 15h2"/><path d="M13 15h2"/></>,
    user:<><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.2 3.1-5 7-5s6.2 1.8 7 5"/></>,
    plus:<><path d="M12 5v14"/><path d="M5 12h14"/></>,
    more:<><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></>,
    agents:<><circle cx="8" cy="8" r="2.5"/><circle cx="17" cy="8" r="2.5"/><path d="M4 19c.4-3.2 1.8-5 4-5s3.6 1.8 4 5"/><path d="M13 19c.3-2.8 1.7-5 4-5s3.6 1.8 4 5"/></>,
    workflow:<><rect x="4" y="5" width="6" height="5" rx="1"/><rect x="14" y="14" width="6" height="5" rx="1"/><path d="M10 7.5h4v9"/><path d="M7 10v4h10"/></>,
    search:<><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    panel:<><path d="M5 6h14"/><path d="M5 12h14"/><path d="M5 18h14"/></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

const links = [
  {href:"/",label:"New conversation",icon:"home" as IconName},
  {href:"/runs",label:"Runs",icon:"runs" as IconName},
  {href:"/workflow",label:"Workflow Studio",icon:"workflow" as IconName},
  {href:"/agents",label:"Agents",icon:"agents" as IconName},
  {href:"/knowledge",label:"Knowledge",icon:"knowledge" as IconName},
  {href:"/network",label:"Agent network",icon:"network" as IconName},
  {href:"/marketplace",label:"Marketplace",icon:"marketplace" as IconName},
  {href:"/connectors",label:"Connectors",icon:"marketplace" as IconName},
  {href:"/billing",label:"Billing",icon:"billing" as IconName},
  {href:"/enterprise",label:"Workspace settings",icon:"workspace" as IconName},
];

const bottomLinks = [
  {href:"/",label:"Home",icon:"home" as IconName},
  {href:"/agents",label:"Agents",icon:"agents" as IconName},
  {href:"/workflow",label:"Workflows",icon:"workflow" as IconName},
  {href:"/knowledge",label:"Library",icon:"knowledge" as IconName},
];

export function MobileWorkspaceNav(){
  const pathname=usePathname();
  const [open,setOpen]=useState(false);

  useEffect(()=>{
    const handler=()=>setOpen(true);
    window.addEventListener("orchestra:mobile-menu",handler);
    return()=>window.removeEventListener("orchestra:mobile-menu",handler);
  },[]);

  return <>
    <button className="mobileNavTrigger" type="button" onClick={()=>setOpen(true)} aria-label="Open navigation"><Icon name="panel" size={20}/></button>
    <nav className="mobileBottomBar" aria-label="Mobile primary navigation">
      {bottomLinks.map(link => (
        <a
          key={link.href}
          href={link.href}
          className={"mobileBottomItem "+(pathname===link.href?"active":"")}
          aria-current={pathname===link.href ? "page" : undefined}
        >
          <Icon name={link.icon} size={17}/>
          <span>{link.label}</span>
        </a>
      ))}
      <button className="mobileBottomItem mobileBottomItemMore" type="button" onClick={()=>setOpen(true)}>
        <Icon name="more" size={17}/>
        <span>More</span>
      </button>
    </nav>
    {open&&<button className="mobileNavBackdrop" type="button" aria-label="Close navigation" onClick={()=>setOpen(false)}/>}
    {open&&<aside className="mobileSideSheet" aria-label="Workspace navigation">
      <div className="mobileSheetHead">
        <a href="/" className="mobileSheetBrand"><span className="brandMark">A</span><span>AI Orchestra</span></a>
        <button className="mobileSheetClose" type="button" onClick={()=>setOpen(false)} aria-label="Close">×</button>
      </div>
      <a href="/" className="mobileSheetNewTask" onClick={()=>setOpen(false)}><Icon name="plus" size={16}/><span>New task</span></a>
      <button className="mobileSheetSearch" type="button" onClick={()=>{setOpen(false);window.dispatchEvent(new CustomEvent("orchestra:search"))}}><Icon name="search" size={15}/><span>Search</span><kbd>⌘K</kbd></button>
      <nav className="mobileSheetNav">
        {links.map(link=><a key={link.href} href={link.href} className={"mobileSheetItem "+(pathname===link.href?"active":"")} onClick={()=>setOpen(false)}><Icon name={link.icon} size={16}/><span>{link.label}</span></a>)}
      </nav>
      <div className="mobileSheetFooter">
        <a href="/enterprise" onClick={()=>setOpen(false)}><Icon name="workspace" size={15}/><span>Workspace</span></a>
        <a href="/auth/sign-in" onClick={()=>setOpen(false)}><Icon name="user" size={15}/><span>Account</span></a>
      </div>
    </aside>}
  </>;
}
